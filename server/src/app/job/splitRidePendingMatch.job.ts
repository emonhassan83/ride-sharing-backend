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
import { haversineMeters, isPointNearRoute } from '../utils/geo.utils';
import { notifyNearbyDriversForSplitRide } from '../utils/notifyDrivers.utils';
import { getDepartureDateTime, getRefundRestrictionHours } from '../utils/rideSchedule.utils';
import { refundToWallet, recalculateSplitFares } from '../utils/splitFare.utils';
import { sendNotification } from '../utils/sentPushNotification';

const BATCH_SIZE = 25;
const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-06-24.dahlia',
  typescript: true,
});

const isRouteMatch = (passenger: any, ride: any): boolean => {
  const coords = ride?.routeGeometry?.coordinates;
  if (!coords?.length) return false;

  const pickupLat = passenger.pickup.coordinates[1];
  const pickupLng = passenger.pickup.coordinates[0];
  const destinationLat = passenger.destination.coordinates[1];
  const destinationLng = passenger.destination.coordinates[0];

  if (!isPointNearRoute(pickupLat, pickupLng, coords)) return false;
  if (!isPointNearRoute(destinationLat, destinationLng, coords)) return false;

  let pickupIdx = -1;
  let destIdx = -1;
  let pickupDist = Infinity;
  let destDist = Infinity;

  coords.forEach(([lng, lat]: [number, number], index: number) => {
    const pd = haversineMeters(pickupLat, pickupLng, lat, lng);
    const dd = haversineMeters(destinationLat, destinationLng, lat, lng);
    if (pd < pickupDist) {
      pickupDist = pd;
      pickupIdx = index;
    }
    if (dd < destDist) {
      destDist = dd;
      destIdx = index;
    }
  });

  return destIdx > pickupIdx;
};

const getUsedSeats = async (rideId: any): Promise<number> => {
  const activePassengers = await Passenger.find({
    rideId,
    status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected, PASSENGER_STATUS.split_matching] },
  })
    .select('requestedSeats')
    .lean();

  return activePassengers.reduce((sum: number, p: any) => sum + (p.requestedSeats || 1), 0);
};

const findMatchingExistingRide = async (passenger: any) => {
  const candidateRides = await Ride.find({
    type: RIDE_TYPE.split,
    splitFareLocked: { $ne: true },
    status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
    departureDate: passenger.departureDate,
  })
    .sort({ driverId: -1, createdAt: 1 })
    .lean();

  for (const ride of candidateRides) {
    if (!isRouteMatch(passenger, ride)) continue;

    const hasPaidBooking = await Booking.exists({
      rideId: ride._id,
      paymentStatus: { $in: [BOOKING_PAYMENT_STATUS.authorized, BOOKING_PAYMENT_STATUS.paid] },
    });
    if (!hasPaidBooking) continue;

    const usedSeats = await getUsedSeats(ride._id);
    if (ride.totalSeats && usedSeats + (passenger.requestedSeats || 1) > ride.totalSeats) continue;

    return { ride, usedSeats };
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

export const checkSplitRidePendingMatches = async () => {
  const redis = getRedisClient();
  const now = new Date();
  const refundRestrictionHours = await getRefundRestrictionHours(RIDE_TYPE.split);

  const passengers = await Passenger.find({
    status: PASSENGER_STATUS.split_matching,
    rideId: null,
    paymentStatus: PASSENGER_PAYMENT_STATUS.authorized,
  })
    .limit(BATCH_SIZE)
    .lean();

  for (const passenger of passengers) {
    try {
      const departureDateTime = getDepartureDateTime(passenger.departureDate, passenger.departureTime);
      const hoursUntilDeparture = (departureDateTime.getTime() - now.getTime()) / 3600000;

      const match = await findMatchingExistingRide(passenger);
      if (match) {
        const { ride } = match;
        const attachedPassenger = await Passenger.findOneAndUpdate(
          { _id: passenger._id, status: PASSENGER_STATUS.split_matching, rideId: null },
          { rideId: ride._id, status: PASSENGER_STATUS.pending },
          { returnDocument: 'after' }
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
          message: 'Your split ride request has been matched to an existing ride.',
        });
        continue;
      }

      if (hoursUntilDeparture <= refundRestrictionHours) {
        await cancelUnmatchedSplitPassenger(passenger);
      } else {
        await redis.hset(`split:matching:passenger:${passenger._id}`, {
          passengerId: passenger._id.toString(),
          userId: passenger.userId.toString(),
          matchingStatus: 'searching_existing_split_ride',
          lastCheckedAt: Date.now().toString(),
        });
      }
    } catch (error) {
      console.error('Split ride pending match job error:', error);
    }
  }
};

