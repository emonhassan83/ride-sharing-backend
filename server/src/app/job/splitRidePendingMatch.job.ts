import Stripe from 'stripe';
import { getRedisClient } from '../config/redis.config';
import { config } from '../config/env.config';
import { getIO } from '../socket/socket.init';
import { Booking } from '../modules/booking/booking.model';
import { BOOKING_STATUS, PAYMENT_STATUS as BOOKING_PAYMENT_STATUS } from '../modules/booking/booking.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import {
  CANCELLED_BY,
  PASSENGER_STATUS,
  PAYMENT_STATUS as PASSENGER_PAYMENT_STATUS,
} from '../modules/passenger/passenger.constant';
import { Payment } from '../modules/payment/payment.model';
import { PAYMENT_STATUS as PAYMENT_RECORD_STATUS } from '../modules/payment/payment.constant';
import { Refund } from '../modules/refund/refund.model';
import { REFUND_STATUS, REFUND_TYPE } from '../modules/refund/refund.constant';
import { modeType } from '../modules/notification/notification.interface';
import { RIDE_STATUS, RIDE_TYPE } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';
import {
  emitNewRideRequestToDriver,
  notifyNearbyDrivers,
  notifyNearbyDriversForSplitRide,
  notifyRiderDriversNotified,
} from '../utils/notifyDrivers.utils';
import {
  formatRideLocalDate,
  getDepartureDateTime,
  getMatchingLastNotifyHours,
} from '../utils/rideSchedule.utils';
import { refundToWallet, recalculateSplitFares, getSplitMaxMatchedRiders } from '../utils/splitFare.utils';
import {
  acquireSplitJoinLock,
  enforceSplitMaxRidersAfterJoin,
  findEligibleExistingSplitRide,
  getCandidateDepartureDates,
  getSplitDestinationMatchRadiusKm,
  getSplitMatchingTimeWindowMinutes,
  getSplitPickupMatchRadiusKm,
  isEligibleSplitPair,
  passengerToMatchCandidate,
  releaseSplitJoinLock,
} from '../utils/splitMatching.utils';
import { sendNotification } from '../utils/sentPushNotification';
import { getRouteGeometry } from '../utils/maps.utils';
import { toLuggageFyiView } from '../utils/luggage.utils';

const BATCH_SIZE = 25;

/**
 * Last-call Solo cutoff: an unmatched split rider is converted no later than
 * this long before pickup, even if the full `releaseHours` search has not run.
 * Must be > 0 — `checkNoDriverFound` cancels any driverless ride at pickup,
 * so a conversion at/after pickup would be cancelled in the same minute.
 */
const SOLO_LAST_CALL_HOURS = 0.25;

/**
 * Solo fallback is due once pickup is inside the `releaseHours` window AND
 * either the rider has had the full `releaseHours` of split search (SPLIT-015:
 * no early conversion) or pickup is within SOLO_LAST_CALL_HOURS.
 *
 * Without the last-call branch, a ride booked less than ~`releaseHours` + a
 * few minutes ahead (e.g. booked 12:35 for 13:45) had a 10-minute window or
 * none at all, and stayed a lone split ride until the no-driver job killed it.
 */
export const isSoloFallbackDue = (
  hoursUntilDeparture: number,
  hoursSinceCreated: number,
  releaseHours: number,
): boolean =>
  hoursUntilDeparture > 0 &&
  hoursUntilDeparture <= releaseHours &&
  (hoursSinceCreated >= releaseHours ||
    hoursUntilDeparture <= SOLO_LAST_CALL_HOURS);

/** Hours this rider has been searching: from their own request, not the ride's creation. */
export const hoursSinceSearchStarted = (
  passenger: { createdAt?: Date | string | null },
  ride: { createdAt?: Date | string | null },
  now: Date,
): number => {
  const startedAt = passenger?.createdAt ?? ride?.createdAt ?? now;
  return Math.max(0, (now.getTime() - new Date(startedAt).getTime()) / 3600000);
};
const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-06-24.dahlia',
  typescript: true,
});

const findMatchingExistingRide = async (passenger: any) => {
  const request = passengerToMatchCandidate(passenger);
  if (!request) return null;

  const candidateRides = await Ride.find({
    type: RIDE_TYPE.split,
    splitFareLocked: { $ne: true },
    status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
    departureDate: {
      $in: getCandidateDepartureDates(
        passenger.departureDate,
        passenger.departureTime,
        await getSplitMatchingTimeWindowMinutes(),
      ),
    },
  })
    .sort({ driverId: -1, createdAt: 1 })
    .lean();

  return findEligibleExistingSplitRide(request, candidateRides, {
    requirePaidBooking: true,
    requestedSeats: passenger.requestedSeats || 1,
    userId: passenger.userId?.toString(),
  });
};

/** Peer-match another authorized backlog passenger (Phase 1/2 + time window). */
const findMatchingBacklogPeer = async (passenger: any) => {
  const request = passengerToMatchCandidate(passenger);
  if (!request) return null;

  const pickupRadiusKm = await getSplitPickupMatchRadiusKm();
  const destinationRadiusKm = await getSplitDestinationMatchRadiusKm();
  const windowMinutes = await getSplitMatchingTimeWindowMinutes();
  const maxMatchedRiders = await getSplitMaxMatchedRiders();

  const peers = await Passenger.find({
    _id: { $ne: passenger._id },
    status: PASSENGER_STATUS.split_matching,
    rideId: null,
    paymentStatus: { $in: [PASSENGER_PAYMENT_STATUS.authorized, PASSENGER_PAYMENT_STATUS.paid] },
    departureDate: {
      $in: getCandidateDepartureDates(
        passenger.departureDate,
        passenger.departureTime,
        windowMinutes,
      ),
    },
    userId: { $ne: passenger.userId },
  })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  for (const peer of peers) {
    const peerCandidate = passengerToMatchCandidate(peer);
    if (!peerCandidate) continue;

    if (
      !isEligibleSplitPair(
        request,
        peerCandidate,
        pickupRadiusKm,
        destinationRadiusKm,
        windowMinutes,
      )
    ) {
      continue;
    }

    // Capacity: seeding a new matched ride with 2 riders must leave room under max.
    if (maxMatchedRiders < 2) continue;

    const seatsNeeded =
      (Number(passenger.requestedSeats) || 1) + (Number(peer.requestedSeats) || 1);
    // New ride has no seat cap until driver assigns vehicle — only rider count matters.
    if (2 > maxMatchedRiders) continue;
    void seatsNeeded;

    return peer;
  }

  return null;
};

const cancelUnmatchedSplitPassenger = async (passenger: any, reason = 'no_matching_split_ride_found') => {
  const io = getIO();
  const redis = getRedisClient();
  const booking = await Booking.findOne({ passengerId: passenger._id });

  if (booking) {
    const payment = await Payment.findOne({ booking: booking._id });

    if (
      payment &&
      [PAYMENT_RECORD_STATUS.authorized, PAYMENT_RECORD_STATUS.requires_reauthorization].includes(payment.status as any)
    ) {
      if (payment.paymentIntentId) {
        try {
          const intent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
          if (intent.status === 'requires_capture') await stripe.paymentIntents.cancel(payment.paymentIntentId);
        } catch (error: any) {
          console.error('Failed to release split matching authorization:', error.message);
        }
      }

      payment.status = PAYMENT_RECORD_STATUS.cancelled_authorization;
      payment.isPaid = false;
      payment.amountToCapture = 0;
      await payment.save();

      booking.paymentStatus = BOOKING_PAYMENT_STATUS.cancelled_authorization as any;
      booking.amountPaid = 0;
    } else if (payment?.status === PAYMENT_RECORD_STATUS.paid || (booking.amountPaid || 0) > 0) {
      const refundAmount = booking.amountPaid || payment?.amount || 0;
      if (payment) {
        payment.status = PAYMENT_RECORD_STATUS.refunded as any;
        payment.isPaid = false;
        await payment.save();
      }

      if (refundAmount > 0) {
        await Refund.create({
          user: booking.userId,
          ...(booking.rideId ? { ride: booking.rideId } : {}),
          type: REFUND_TYPE.split_ride,
          paymentIntentId: payment?.paymentIntentId || payment?.transactionId || booking.transactionId || '',
          amount: refundAmount,
          reason,
          note: 'Split ride matching cancelled because no matching existing split ride was found',
          status: REFUND_STATUS.confirmed,
        });
        await refundToWallet(booking.userId.toString(), refundAmount, reason, io);
      }

      booking.paymentStatus = BOOKING_PAYMENT_STATUS.refunded as any;
      booking.refundAmount = refundAmount;
    }

    booking.bookingStatus = BOOKING_STATUS.cancelled;
    await booking.save();
  }

  await Passenger.findByIdAndUpdate(passenger._id, {
    status: PASSENGER_STATUS.cancelled,
    paymentStatus: PASSENGER_PAYMENT_STATUS.cancelled_authorization,
    cancellationReason: reason,
    cancelledBy: CANCELLED_BY.system,
    fallbackReason: reason,
  });

  await redis.del(`split:matching:passenger:${passenger._id}`);

  io.to(`user:${passenger.userId}`).emit('split-ride:no-match-cancelled', {
    passengerId: passenger._id,
    bookingId: booking?._id,
    message: 'No matching split ride was found. Booking has been cancelled.',
  });

  const user = await User.findById(passenger.userId).select('fcmToken').lean();
  if (user?.fcmToken) {
    sendNotification([user.fcmToken], {
      receiver: passenger.userId,
      message: 'Split Ride Cancelled',
      description: 'No matching split ride was found. Your booking has been cancelled.',
      reference: passenger._id.toString(),
      modelType: modeType.Passenger,
      data: { type: 'SPLIT_RIDE_NO_MATCH', passengerId: passenger._id.toString() },
    }).catch(() => {});
  }
};

const notifyMatchedRideDriver = async (ride: any, passenger: any, booking: any) => {
  const io = getIO();
  const redis = getRedisClient();
  const rider = await User.findById(passenger.userId).select('_id name profileImage').lean();

  const ridePayload = {
    _id: passenger._id,
    userId: {
      _id: rider?._id || null,
      name: rider?.name || '',
      profileImage: rider?.profileImage || null,
    },
    rideId: {
      _id: ride._id,
      type: ride.type,
      id: ride.id || '',
    },
    bookingId: booking._id.toString(),
    pickup: passenger.pickup,
    destination: passenger.destination,
    departureDate: ride.departureDate,
    departureTime: ride.departureTime,
    rideType: ride.type,
    requestedSeats: passenger.requestedSeats || 1,
    estimatedFare: passenger.estimatedFare || booking.totalFare || 0,
    estimatedDistanceKm: passenger.estimatedDistanceKm || 0,
    estimatedDurationMinutes: passenger.estimatedDurationMinutes || 0,
    status: PASSENGER_STATUS.pending,
    createdAt: passenger.createdAt,
    ...toLuggageFyiView(passenger),
  };

  const driverId = ride.driverId?.toString();
  if (driverId) {
    const sent = await emitNewRideRequestToDriver(
      io,
      redis,
      driverId,
      ride._id.toString(),
      ridePayload,
    );
    if (!sent) return 0;
    await Ride.findByIdAndUpdate(ride._id, { $addToSet: { notifiedDriverIds: driverId } });
    return 1;
  }

  const pickupCoords = passenger.pickup.coordinates || ride.pickup.coordinates;
  return notifyNearbyDriversForSplitRide(
    ride._id.toString(),
    ride.routeGeometry,
    { lat: pickupCoords[1], lng: pickupCoords[0] },
    ridePayload,
    redis,
    io,
    passenger._id.toString()
  );
};

const attachPassengerToRide = async (
  passengerId: any,
  rideId: any,
  matchedVia: 'auto_existing' | 'auto_peer' | 'manual_join' | 'solo_fallback',
  extra?: Record<string, any>,
) => {
  return Passenger.findOneAndUpdate(
    { _id: passengerId, status: PASSENGER_STATUS.split_matching, rideId: null },
    {
      rideId,
      status: PASSENGER_STATUS.pending,
      matchedVia,
      matchedAt: new Date(),
      originalRideIntent: 'split',
      cancellationReason: undefined,
      ...extra,
    },
    { returnDocument: 'after' },
  );
};

/** Create a new split Ride from two backlog peers, then notify drivers. */
const createPeerMatchedSplitRide = async (host: any, peer: any) => {
  const io = getIO();
  const redis = getRedisClient();

  const hostBooking = await Booking.findOne({ passengerId: host._id });
  const peerBooking = await Booking.findOne({ passengerId: peer._id });
  if (!hostBooking || !peerBooking) return false;

  const pickupCoords = host.pickup?.coordinates || [];
  const destinationCoords = host.destination?.coordinates || [];
  if (pickupCoords.length < 2 || destinationCoords.length < 2) return false;

  let routeGeometry: any = {};
  try {
    routeGeometry = await getRouteGeometry(
      { lat: pickupCoords[1], lng: pickupCoords[0] },
      { lat: destinationCoords[1], lng: destinationCoords[0] },
    );
  } catch {
    /* optional */
  }

  const ride = await Ride.create({
    type: RIDE_TYPE.split,
    rideCreatedBy: host.userId,
    pickup: host.pickup,
    destination: host.destination,
    departureDate: host.departureDate,
    departureTime: host.departureTime,
    totalSeats: 0,
    bookedSeats: 0,
    status: RIDE_STATUS.pending,
    routeGeometry,
  });

  const attachedHost = await attachPassengerToRide(host._id, ride._id, 'auto_peer');
  const attachedPeer = await attachPassengerToRide(peer._id, ride._id, 'auto_peer');

  if (!attachedHost || !attachedPeer) {
    // Race: one was claimed elsewhere — roll back incomplete attach.
    if (attachedHost) {
      await Passenger.findByIdAndUpdate(attachedHost._id, {
        rideId: null,
        status: PASSENGER_STATUS.split_matching,
        matchedVia: undefined,
        matchedAt: undefined,
      });
    }
    if (attachedPeer) {
      await Passenger.findByIdAndUpdate(attachedPeer._id, {
        rideId: null,
        status: PASSENGER_STATUS.split_matching,
        matchedVia: undefined,
        matchedAt: undefined,
      });
    }
    await Ride.findByIdAndDelete(ride._id);
    return false;
  }

  hostBooking.rideId = ride._id as any;
  peerBooking.rideId = ride._id as any;
  await hostBooking.save();
  await peerBooking.save();

  await redis.del(`split:matching:passenger:${host._id}`);
  await redis.del(`split:matching:passenger:${peer._id}`);

  await recalculateSplitFares(ride._id.toString(), 'passenger_joined');

  await notifyMatchedRideDriver(ride, attachedHost.toObject(), hostBooking);
  // Peer share of the same ride request — drivers already notified above.
  await notifyMatchedRideDriver(ride, attachedPeer.toObject(), peerBooking);

  for (const p of [attachedHost, attachedPeer]) {
    const userId = p.userId?.toString();
    if (!userId) continue;

    // Cumulative count: the peer's call above notifies 0 *new* drivers, but
    // both riders must see how many drivers actually have this ride.
    const notifiedDrivers = await notifyRiderDriversNotified({
      io,
      userId,
      rideId: ride._id.toString(),
      passengerId: p._id.toString(),
      bookingId: (p._id.equals(attachedHost._id) ? hostBooking : peerBooking)._id.toString(),
      newlyNotified: 0,
    });

    io.to(`user:${userId}`).emit('split-ride:matched', {
      rideId: ride._id,
      passengerId: p._id,
      matchedVia: 'auto_peer',
      notifiedDrivers,
      message: 'Your split ride request has been matched with another rider.',
    });
  }

  console.log(
    `✅ Split peer-matched | ride: ${ride._id} | host: ${host._id} | peer: ${peer._id}`,
  );
  return true;
};

const releaseUnmatchedSplitToSolo = async (passenger: any) => {
  const redis = getRedisClient();

  const booking = await Booking.findOne({ passengerId: passenger._id });
  if (!booking) {
    await cancelUnmatchedSplitPassenger(passenger, 'solo_fallback_missing_booking');
    return;
  }

  const pickupCoords = passenger.pickup?.coordinates || [];
  const destinationCoords = passenger.destination?.coordinates || [];
  if (pickupCoords.length < 2 || destinationCoords.length < 2) {
    await cancelUnmatchedSplitPassenger(passenger, 'solo_fallback_invalid_route');
    return;
  }

  let routeGeometry: any = {};
  try {
    routeGeometry = await getRouteGeometry(
      { lat: pickupCoords[1], lng: pickupCoords[0] },
      { lat: destinationCoords[1], lng: destinationCoords[0] },
    );
  } catch {
    /* optional for matching */
  }

  const ride = await Ride.create({
    type: RIDE_TYPE.private,
    rideCreatedBy: passenger.userId,
    pickup: passenger.pickup,
    destination: passenger.destination,
    departureDate: passenger.departureDate,
    departureTime: passenger.departureTime,
    totalSeats: 0,
    bookedSeats: 0,
    status: RIDE_STATUS.pending,
    routeGeometry,
  });

  const attachedPassenger = await attachPassengerToRide(
    passenger._id,
    ride._id,
    'solo_fallback',
    { fallbackReason: 'unmatched_within_1h_of_pickup' },
  );

  if (!attachedPassenger) {
    await Ride.findByIdAndDelete(ride._id);
    console.error(
      `Solo fallback attach failed | passenger: ${passenger._id} | status may have changed`,
    );
    return;
  }

  booking.rideId = ride._id as any;
  booking.driverId = null as any;
  await booking.save();

  await redis.del(`split:matching:passenger:${passenger._id}`);

  const notified = await dispatchSoloFallbackRide(ride, attachedPassenger, booking);

  console.log(
    `✅ Split unmatched released as Solo | passenger: ${passenger._id} | ride: ${ride._id} | drivers: ${notified}`,
  );
};

/**
 * After a rider has been moved onto a PRIVATE ride as Solo fallback:
 * notify nearby drivers, tell drivers who saw the split request that it is now
 * Solo, and tell the rider how many drivers have it. Returns new drivers notified.
 */
const dispatchSoloFallbackRide = async (
  ride: any,
  attachedPassenger: any,
  booking: any,
): Promise<number> => {
  const io = getIO();
  const redis = getRedisClient();

  const rider = await User.findById(attachedPassenger.userId)
    .select('_id name profileImage')
    .lean();

  const ridePayload = {
    _id: attachedPassenger._id,
    userId: {
      _id: rider?._id || null,
      name: rider?.name || '',
      profileImage: rider?.profileImage || null,
    },
    rideId: {
      _id: ride._id,
      type: RIDE_TYPE.private,
      id: (ride as any).id || '',
    },
    bookingId: booking._id.toString(),
    pickup: attachedPassenger.pickup,
    destination: attachedPassenger.destination,
    departureDate: ride.departureDate,
    departureTime: ride.departureTime,
    rideType: RIDE_TYPE.private,
    vehicleType: (ride as any).vehicleType || null,
    requestedSeats: attachedPassenger.requestedSeats || 1,
    estimatedFare: attachedPassenger.estimatedFare || booking.totalFare || 0,
    estimatedDistanceKm: attachedPassenger.estimatedDistanceKm || 0,
    estimatedDurationMinutes: attachedPassenger.estimatedDurationMinutes || 0,
    status: PASSENGER_STATUS.pending,
    createdAt: attachedPassenger.createdAt,
    convertedFromSplit: true,
    matchedVia: 'solo_fallback',
    ...toLuggageFyiView(attachedPassenger),
  };

  const pickupCoords =
    attachedPassenger.pickup?.coordinates || ride.pickup?.coordinates || [];
  const notified = await notifyNearbyDrivers(
    ride._id.toString(),
    { lat: pickupCoords[1], lng: pickupCoords[0] },
    ridePayload,
    redis,
    io,
    attachedPassenger._id.toString(),
    10,
  );

  await redis.hset(`ride:request:${ride._id}`, {
    bookingId: booking._id.toString(),
    passengerId: attachedPassenger._id.toString(),
    notifiedCount: notified.toString(),
    matchingStatus: notified > 0 ? 'notified' : 'scheduled_pending',
    lastNotifiedAt: notified > 0 ? Date.now().toString() : '',
  });
  await redis.zadd(
    'ride:matching:queue',
    getDepartureDateTime(ride.departureDate, ride.departureTime).getTime(),
    ride._id.toString(),
  );

  const convertedPayload = {
    rideId: ride._id,
    passengerId: attachedPassenger._id,
    bookingId: booking._id,
    matchedVia: 'solo_fallback',
    rideType: RIDE_TYPE.private,
    requestedRide: ridePayload,
    message:
      'No split match found within 1 hour of pickup. Ride converted to Solo.',
  };

  // Passenger
  io.to(`user:${attachedPassenger.userId}`).emit(
    'split-ride:converted-to-solo',
    convertedPayload,
  );

  // Drivers who received this request (split or Solo) so their list updates.
  const refreshedRide = await Ride.findById(ride._id)
    .select('notifiedDriverIds')
    .lean();
  const driverIds = new Set<string>(
    ((refreshedRide as any)?.notifiedDriverIds || []).map((id: any) =>
      id.toString(),
    ),
  );
  for (const driverId of driverIds) {
    io.to(`driver:${driverId}`).emit(
      'split-ride:converted-to-solo',
      convertedPayload,
    );
  }

  await notifyRiderDriversNotified({
    io,
    userId: attachedPassenger.userId.toString(),
    rideId: ride._id.toString(),
    passengerId: attachedPassenger._id.toString(),
    bookingId: booking._id.toString(),
    newlyNotified: notified,
    variant: 'solo_fallback',
  });

  return notified;
};

/**
 * Lone split rides → Solo, `matchingLastNotifyHours` (1h) before pickup.
 *
 * The backlog loader only sees passengers still in `split_matching` with no
 * ride. A rider who is already ON a split Ride (booked via `ride-request` with
 * type=split, or whose split partner cancelled) but is still alone with no
 * driver was never converted — the no-driver job just cancelled it at pickup.
 * Rides with 2+ matched riders stay split (that is a real shared trip).
 */
const releaseLoneSplitRidesToSolo = async (releaseHours: number) => {
  const now = new Date();
  const horizonLocal = formatRideLocalDate(
    new Date(now.getTime() + (releaseHours + 24) * 3600000),
  );
  const yesterdayLocal = formatRideLocalDate(
    new Date(now.getTime() - 24 * 3600000),
  );

  const rides = await Ride.find({
    type: RIDE_TYPE.split,
    status: RIDE_STATUS.pending,
    $or: [{ driverId: { $exists: false } }, { driverId: null }],
    departureDate: { $gte: yesterdayLocal, $lte: horizonLocal },
  })
    .sort({ departureDate: 1, departureTime: 1 })
    .limit(BATCH_SIZE)
    .lean();

  for (const ride of rides) {
    try {
      const departureDateTime = getDepartureDateTime(
        ride.departureDate,
        ride.departureTime,
      );
      const hoursUntilDeparture =
        (departureDateTime.getTime() - now.getTime()) / 3600000;

      // Cheap pre-filter; the full rule needs the lone rider (below).
      if (hoursUntilDeparture <= 0 || hoursUntilDeparture > releaseHours) {
        continue;
      }

      const rideId = ride._id.toString();
      const locked = await acquireSplitJoinLock(rideId);
      if (!locked) continue;

      try {
        const active = await Passenger.find({
          rideId: ride._id,
          status: {
            $nin: [
              PASSENGER_STATUS.cancelled,
              PASSENGER_STATUS.rejected,
              PASSENGER_STATUS.split_matching,
            ],
          },
        }).lean();
        if (active.length !== 1) continue;

        const lone: any = active[0];
        if (lone.status !== PASSENGER_STATUS.pending) continue;
        if (
          !(
            [
              PASSENGER_PAYMENT_STATUS.authorized,
              PASSENGER_PAYMENT_STATUS.paid,
            ] as string[]
          ).includes(lone.paymentStatus)
        ) {
          continue; // unpaid requests are not being matched at all
        }

        // Issue 15: the search time is the RIDER's, not the ride's. A rider left
        // alone on an older ride (partner cancelled) used to inherit the ride's
        // createdAt and was converted minutes after booking.
        if (
          !isSoloFallbackDue(
            hoursUntilDeparture,
            hoursSinceSearchStarted(lone, ride, now),
            releaseHours,
          )
        ) {
          continue;
        }

        const booking = await Booking.findOne({
          passengerId: lone._id,
          rideId: ride._id,
        });
        if (!booking) continue;

        // Atomic flip: a driver accepting in parallel wins, and a second job
        // instance cannot convert the same ride twice.
        const converted = await Ride.findOneAndUpdate(
          {
            _id: ride._id,
            type: RIDE_TYPE.split,
            status: RIDE_STATUS.pending,
            $or: [{ driverId: { $exists: false } }, { driverId: null }],
          },
          { type: RIDE_TYPE.private },
          { returnDocument: 'after' },
        ).lean();
        if (!converted) continue;

        const attachedPassenger = await Passenger.findByIdAndUpdate(
          lone._id,
          {
            matchedVia: 'solo_fallback',
            fallbackReason: 'unmatched_within_1h_of_pickup',
            originalRideIntent: 'split',
          },
          { returnDocument: 'after' },
        ).lean();

        const notified = await dispatchSoloFallbackRide(
          converted,
          attachedPassenger || lone,
          booking,
        );

        console.log(
          `✅ Lone split ride converted to Solo | ride: ${rideId} | passenger: ${lone._id} | hoursUntil: ${hoursUntilDeparture.toFixed(2)} | new drivers: ${notified}`,
        );
      } finally {
        await releaseSplitJoinLock(rideId);
      }
    } catch (error) {
      console.error('Lone split → Solo error:', error);
    }
  }
};

const loadSplitMatchingBacklog = async () => {
  const authorizedPassengers = await Passenger.find({
    status: PASSENGER_STATUS.split_matching,
    rideId: null,
    paymentStatus: { $in: [PASSENGER_PAYMENT_STATUS.authorized, PASSENGER_PAYMENT_STATUS.paid] },
  })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE)
    .lean();

  // Repair path: Booking authorized but Passenger.paymentStatus still pending.
  const readyBookings = await Booking.find({
    paymentStatus: { $in: [BOOKING_PAYMENT_STATUS.authorized, BOOKING_PAYMENT_STATUS.paid] },
    $or: [{ rideId: null }, { rideId: { $exists: false } }],
  })
    .select('passengerId')
    .limit(BATCH_SIZE)
    .lean();

  const bookingPassengerIds = readyBookings
    .map((b) => b.passengerId)
    .filter(Boolean);

  let repaired: any[] = [];
  if (bookingPassengerIds.length) {
    repaired = await Passenger.find({
      _id: { $in: bookingPassengerIds },
      status: PASSENGER_STATUS.split_matching,
      rideId: null,
      paymentStatus: { $ne: PASSENGER_PAYMENT_STATUS.authorized },
    }).lean();

    if (repaired.length) {
      await Passenger.updateMany(
        { _id: { $in: repaired.map((p) => p._id) } },
        { $set: { paymentStatus: PASSENGER_PAYMENT_STATUS.authorized } },
      );
      repaired = repaired.map((p) => ({
        ...p,
        paymentStatus: PASSENGER_PAYMENT_STATUS.authorized,
      }));
    }
  }

  const byId = new Map<string, any>();
  for (const p of [...authorizedPassengers, ...repaired]) {
    byId.set(p._id.toString(), p);
  }
  return Array.from(byId.values());
};

export const checkSplitRidePendingMatches = async () => {
  const redis = getRedisClient();
  const now = new Date();
  const releaseHours = await getMatchingLastNotifyHours();

  // Riders already on a split Ride but still alone with no driver.
  try {
    await releaseLoneSplitRidesToSolo(releaseHours);
  } catch (error) {
    console.error('Lone split → Solo phase error:', error);
  }

  const passengers = await loadSplitMatchingBacklog();

  // Prefer riders already inside the Solo window so BATCH_SIZE cannot starve them.
  passengers.sort((a, b) => {
    const aH =
      (getDepartureDateTime(a.departureDate, a.departureTime).getTime() - now.getTime()) /
      3600000;
    const bH =
      (getDepartureDateTime(b.departureDate, b.departureTime).getTime() - now.getTime()) /
      3600000;
    const aDue = aH <= releaseHours ? 0 : 1;
    const bDue = bH <= releaseHours ? 0 : 1;
    if (aDue !== bDue) return aDue - bDue;
    return aH - bH;
  });

  for (const passenger of passengers.slice(0, BATCH_SIZE)) {
    try {
      const departureDateTime = getDepartureDateTime(
        passenger.departureDate,
        passenger.departureTime,
      );
      const hoursUntilDeparture =
        (departureDateTime.getTime() - now.getTime()) / 3600000;
      const createdAtMs = passenger.createdAt
        ? new Date(passenger.createdAt).getTime()
        : now.getTime();
      const hoursSinceCreated = Math.max(0, (now.getTime() - createdAtMs) / 3600000);
      // Full matchingLastNotifyHours search once pickup is inside that window;
      // late bookings get a last-call conversion 15 min before pickup.
      const inSoloWindow = isSoloFallbackDue(
        hoursUntilDeparture,
        hoursSinceCreated,
        releaseHours,
      );

      if (inSoloWindow) {
        console.log(
          `Solo fallback due | passenger: ${passenger._id} | hoursUntil: ${hoursUntilDeparture.toFixed(2)} | searchedHours: ${hoursSinceCreated.toFixed(2)}`,
        );
        await releaseUnmatchedSplitToSolo(passenger);
        continue;
      }

      // Pickup reached while still unmatched (job was down / missed the
      // last-call window). Matching after pickup makes no sense — release.
      if (hoursUntilDeparture <= 0) {
        await cancelUnmatchedSplitPassenger(
          passenger,
          'departure_passed_unmatched',
        );
        continue;
      }

      // 1) Match to an existing paid split ride (Phase 1/2 + time window).
      const match = await findMatchingExistingRide(passenger);
      if (match) {
        const { ride } = match;
        const rideLockId = ride._id.toString();
        const locked = await acquireSplitJoinLock(rideLockId);
        if (locked) {
          try {
            const attachedPassenger = await attachPassengerToRide(
              passenger._id,
              ride._id,
              'auto_existing',
            );
            if (attachedPassenger) {
              const cap = await enforceSplitMaxRidersAfterJoin(
                ride._id,
                passenger._id,
                'detach_to_matching',
              );
              if (cap.ok) {
                const booking = await Booking.findOneAndUpdate(
                  { passengerId: passenger._id },
                  { rideId: ride._id, driverId: ride.driverId || null },
                  { returnDocument: 'after' },
                );
                if (booking) {
                  await redis.del(`split:matching:passenger:${passenger._id}`);
                  await redis.hset(`ride:request:${ride._id}:${passenger._id}`, {
                    userId: passenger.userId.toString(),
                    passengerId: passenger._id.toString(),
                    rideId: ride._id.toString(),
                    bookingId: booking._id.toString(),
                    matchingStatus: 'matched_after_payment',
                    timestamp: Date.now().toString(),
                  });

                  await recalculateSplitFares(
                    ride._id.toString(),
                    'passenger_joined',
                  );
                  const newlyNotified = await notifyMatchedRideDriver(
                    ride,
                    attachedPassenger.toObject(),
                    booking,
                  );

                  // Previously the rider got only `split-ride:matched` here and
                  // never learned how many drivers have the ride.
                  const notifiedDrivers = await notifyRiderDriversNotified({
                    io: getIO(),
                    userId: passenger.userId.toString(),
                    rideId: ride._id.toString(),
                    passengerId: passenger._id.toString(),
                    bookingId: booking._id.toString(),
                    newlyNotified,
                  });

                  getIO().to(`user:${passenger.userId}`).emit('split-ride:matched', {
                    rideId: ride._id,
                    passengerId: passenger._id,
                    bookingId: booking._id,
                    matchedVia: 'auto_existing',
                    notifiedDrivers,
                    message:
                      'Your split ride request has been matched to an existing ride.',
                  });
                  continue;
                }

                // Attach without booking — roll back so Solo/match can retry.
                await Passenger.findByIdAndUpdate(passenger._id, {
                  rideId: null,
                  status: PASSENGER_STATUS.split_matching,
                  matchedVia: undefined,
                  matchedAt: undefined,
                });
              }
            }
          } finally {
            await releaseSplitJoinLock(rideLockId);
          }
        }
      }

      // 2) Peer-match another backlog rider → create split Ride, then notify drivers.
      const peer = await findMatchingBacklogPeer(passenger);
      if (peer) {
        const stillPeer = await Passenger.findOne({
          _id: peer._id,
          status: PASSENGER_STATUS.split_matching,
          rideId: null,
        }).lean();
        if (stillPeer) {
          const created = await createPeerMatchedSplitRide(passenger, stillPeer);
          if (created) continue;
        }
      }

      await redis.hset(`split:matching:passenger:${passenger._id}`, {
        passengerId: passenger._id.toString(),
        userId: passenger.userId.toString(),
        matchingStatus: 'searching_split_peers',
        lastCheckedAt: Date.now().toString(),
        hoursUntilDeparture: hoursUntilDeparture.toFixed(2),
      });
    } catch (error) {
      console.error('Split ride pending match job error:', error);
    }
  }
};
