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
import { notifyNearbyDrivers, notifyNearbyDriversForSplitRide } from '../utils/notifyDrivers.utils';
import {
  getDepartureDateTime,
  getMatchingLastNotifyHours,
} from '../utils/rideSchedule.utils';
import { refundToWallet, recalculateSplitFares, getSplitMaxMatchedRiders } from '../utils/splitFare.utils';
import {
  findEligibleExistingSplitRide,
  getSplitDestinationMatchRadiusKm,
  getSplitMatchingTimeWindowMinutes,
  getSplitPickupMatchRadiusKm,
  isEligibleSplitPair,
  passengerToMatchCandidate,
} from '../utils/splitMatching.utils';
import { sendNotification } from '../utils/sentPushNotification';
import { getRouteGeometry } from '../utils/maps.utils';

const BATCH_SIZE = 25;
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
    departureDate: passenger.departureDate,
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
    paymentStatus: PASSENGER_PAYMENT_STATUS.authorized,
    departureDate: passenger.departureDate,
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
  };

  const driverId = ride.driverId?.toString();
  if (driverId) {
    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    await Ride.findByIdAndUpdate(ride._id, { $addToSet: { notifiedDriverIds: driverId } });

    const driver = await User.findById(driverId).select('fcmToken').lean();
    if (driver?.fcmToken) {
      sendNotification([driver.fcmToken], {
        receiver: driverId,
        message: 'New Split Ride Request!',
        description: 'A passenger was matched to your split ride.',
        reference: passenger._id.toString(),
        modelType: modeType.Passenger,
        data: {
          type: 'SPLIT_RIDE_REQUEST',
          rideId: ride._id.toString(),
          passengerId: passenger._id.toString(),
          bookingId: booking._id.toString(),
          rideType: 'split',
        },
      }).catch(() => {});
    }
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
  await notifyMatchedRideDriver(ride, attachedPeer.toObject(), peerBooking);

  for (const p of [attachedHost, attachedPeer]) {
    io.to(`user:${p.userId}`).emit('split-ride:matched', {
      rideId: ride._id,
      passengerId: p._id,
      matchedVia: 'auto_peer',
      message: 'Your split ride request has been matched with another rider.',
    });
  }

  console.log(
    `✅ Split peer-matched | ride: ${ride._id} | host: ${host._id} | peer: ${peer._id}`,
  );
  return true;
};

const releaseUnmatchedSplitToSolo = async (passenger: any) => {
  const io = getIO();
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
    return;
  }

  booking.rideId = ride._id as any;
  booking.driverId = null as any;
  await booking.save();

  await redis.del(`split:matching:passenger:${passenger._id}`);

  const rider = await User.findById(passenger.userId)
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
      type: ride.type,
      id: (ride as any).id || '',
    },
    bookingId: booking._id.toString(),
    pickup: attachedPassenger.pickup,
    destination: attachedPassenger.destination,
    departureDate: ride.departureDate,
    departureTime: ride.departureTime,
    rideType: ride.type,
    requestedSeats: attachedPassenger.requestedSeats || 1,
    estimatedFare: attachedPassenger.estimatedFare || booking.totalFare || 0,
    estimatedDistanceKm: attachedPassenger.estimatedDistanceKm || 0,
    estimatedDurationMinutes: attachedPassenger.estimatedDurationMinutes || 0,
    status: PASSENGER_STATUS.pending,
    createdAt: attachedPassenger.createdAt,
  };

  const notified = await notifyNearbyDrivers(
    ride._id.toString(),
    { lat: pickupCoords[1], lng: pickupCoords[0] },
    ridePayload,
    redis,
    io,
    attachedPassenger._id.toString(),
    10,
    undefined,
    { notifyMode: 'all_eligible' },
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
    new Date(`${ride.departureDate}T${ride.departureTime}:00`).getTime(),
    ride._id.toString(),
  );

  console.log(
    `✅ Split unmatched released as Solo | passenger: ${passenger._id} | ride: ${ride._id} | drivers: ${notified}`,
  );
};

export const checkSplitRidePendingMatches = async () => {
  const redis = getRedisClient();
  const now = new Date();
  const releaseHours = await getMatchingLastNotifyHours();

  const passengers = await Passenger.find({
    status: PASSENGER_STATUS.split_matching,
    rideId: null,
    paymentStatus: PASSENGER_PAYMENT_STATUS.authorized,
  })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE)
    .lean();

  for (const passenger of passengers) {
    try {
      const departureDateTime = getDepartureDateTime(passenger.departureDate, passenger.departureTime);
      const hoursUntilDeparture = (departureDateTime.getTime() - now.getTime()) / 3600000;

      // 1) Match to an existing paid split ride (Phase 1/2 + time window).
      const match = await findMatchingExistingRide(passenger);
      if (match) {
        const { ride } = match;
        const attachedPassenger = await attachPassengerToRide(
          passenger._id,
          ride._id,
          'auto_existing',
        );
        if (!attachedPassenger) continue;

        const booking = await Booking.findOneAndUpdate(
          { passengerId: passenger._id },
          { rideId: ride._id, driverId: ride.driverId || null },
          { returnDocument: 'after' }
        );
        if (!booking) continue;

        await redis.del(`split:matching:passenger:${passenger._id}`);
        await redis.hset(`ride:request:${ride._id}:${passenger._id}`, {
          userId: passenger.userId.toString(),
          passengerId: passenger._id.toString(),
          rideId: ride._id.toString(),
          bookingId: booking._id.toString(),
          matchingStatus: 'matched_after_payment',
          timestamp: Date.now().toString(),
        });

        await recalculateSplitFares(ride._id.toString(), 'passenger_joined');
        await notifyMatchedRideDriver(ride, attachedPassenger.toObject(), booking);

        getIO().to(`user:${passenger.userId}`).emit('split-ride:matched', {
          rideId: ride._id,
          passengerId: passenger._id,
          bookingId: booking._id,
          matchedVia: 'auto_existing',
          message: 'Your split ride request has been matched to an existing ride.',
        });
        continue;
      }

      // 2) Peer-match another backlog rider → create split Ride, then notify drivers.
      const peer = await findMatchingBacklogPeer(passenger);
      if (peer) {
        // Refresh peer still in backlog (race-safe createPeerMatchedSplitRide).
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

      // Past pickup with no match → cancel authorization.
      if (hoursUntilDeparture < 0) {
        await cancelUnmatchedSplitPassenger(passenger, 'departure_passed_unmatched');
        continue;
      }

      // Client rule: 1h before pickup, release unmatched backlog to drivers as Solo.
      if (hoursUntilDeparture <= releaseHours) {
        await releaseUnmatchedSplitToSolo(passenger);
        continue;
      }

      await redis.hset(`split:matching:passenger:${passenger._id}`, {
        passengerId: passenger._id.toString(),
        userId: passenger.userId.toString(),
        matchingStatus: 'searching_split_peers',
        lastCheckedAt: Date.now().toString(),
      });
    } catch (error) {
      console.error('Split ride pending match job error:', error);
    }
  }
};
