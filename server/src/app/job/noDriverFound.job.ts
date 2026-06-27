// jobs/noDriverFound.job.ts
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { CANCELLED_BY, RIDE_STATUS } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';
import { Setting } from '../modules/settings/settings.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from '../utils/sentPushNotification';
import { notifyNearbyDrivers } from '../utils/notifyDrivers.utils';
import { getIO } from '../socket/socket.init';

const BATCH_SIZE = 50;

// ── Load settings with fallback ───────────────────────────────────────────────
const getMatchingSettings = async (): Promise<{
  notifyHours: number; // re-notify X hours before departure
  cancelHours: number; // cancel Y hours before departure
}> => {
  const settings = await Setting.find({
    key: { $in: ['matchingNoDriverNotifyHours', 'matchingLastNotifyHours'] },
  }).lean();

  const map: Record<string, number> = {};
  for (const s of settings) map[s.key] = Number(s.value);

  return {
    notifyHours: map.matchingNoDriverNotifyHours ?? 48, // fallback 48h
    cancelHours: map.matchingLastNotifyHours ?? 24, // fallback 24h
  };
};

export const checkNoDriverFound = async () => {
  const redis = getRedisClient();
  const io = getIO();
  const now = new Date();

  const { notifyHours, cancelHours } = await getMatchingSettings();

  // ── Phase 2: Re-notify drivers (X hours before departure) ────────────────
  const reNotifyBefore = new Date(now.getTime() + notifyHours * 3600000);

  // Grace period: ignore rides created in the last 30 minutes (already notified by rideRequest handler)
  const gracePeriodCutoff = new Date(now.getTime() - 30 * 60 * 1000);

  const ridesForRenotify = await Ride.find({
    status: RIDE_STATUS.pending,
    departureDate: { $lte: reNotifyBefore.toISOString().split('T')[0] },
    reNotifiedAt: { $exists: false },
    createdAt: { $lte: gracePeriodCutoff },
  })
    .limit(BATCH_SIZE)
    .lean();

  for (const ride of ridesForRenotify) {
    // Check departure is actually within the window
    const departureMs = new Date(
      `${ride.departureDate}T${ride.departureTime}:00`
    ).getTime();

    const hoursUntilDeparture = (departureMs - now.getTime()) / 3600000;

    // Only re-notify if within notify window but not yet in cancel window
    if (
      hoursUntilDeparture > cancelHours &&
      hoursUntilDeparture <= notifyHours
    ) {
      const passenger = await Passenger.findOne({
        rideId: ride._id,
        status: PASSENGER_STATUS.pending,
      }).lean();

      if (!passenger) continue;

      const rider = await User.findById((ride as any).rideCreatedBy)
        .select('_id name profileImage')
        .lean();

      // Re-notify nearby drivers
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
          id: (ride as any).id || '',
        },
        pickup: {
          address: ride.pickup.address,
          coordinates: ride.pickup.coordinates,
        },
        destination: {
          address: ride.destination.address,
          coordinates: ride.destination.coordinates,
        },
        departureDate: ride.departureDate,
        departureTime: ride.departureTime,
        requestedSeats: (passenger as any).requestedSeats || 1,
        estimatedFare: (passenger as any).estimatedFare || 0,
        estimatedDistanceKm: (passenger as any).estimatedDistanceKm || 0,
        status: PASSENGER_STATUS.pending,
        createdAt: (passenger as any).createdAt,
      };

      const notified = await notifyNearbyDrivers(
        ride._id.toString(),
        { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] },
        ridePayload,
        redis,
        io,
        passenger._id.toString()
      );

      // Mark as re-notified
      await Ride.findByIdAndUpdate(ride._id, {
        reNotifiedAt: now,
      });

      // ✅ Notify rider — re-matching in progress
      const riderUser = await User.findById((ride as any).rideCreatedBy)
        .select('fcmToken')
        .lean();

      io.to(`user:${(ride as any).rideCreatedBy}`).emit('ride:re-matching', {
        rideId: ride._id,
        message: `We're still looking for a driver. ${notified} driver(s) notified.`,
      });

      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: (ride as any).rideCreatedBy,
          message: 'Still Searching for a Driver',
          description: `We're still trying to find a driver for your ride. ${notified} driver(s) have been notified.`,
          reference: ride._id.toString(),
          modelType: modeType.Ride,
        }).catch(() => {});
      }

      console.log(
        `🔔 Phase 2 re-notify | ride ${ride._id} | ${notified} drivers | ${hoursUntilDeparture.toFixed(1)}h before departure`
      );
    }
  }

  // ── Phase 3: Cancel rides (Y hours before departure, still no driver) ─────
  const cancelBefore = new Date(now.getTime() + cancelHours * 3600000);

  const ridesForCancel = await Ride.find({
    status: RIDE_STATUS.pending,
    departureDate: { $lte: cancelBefore.toISOString().split('T')[0] },
  })
    .limit(BATCH_SIZE)
    .lean();

  const cancelRideIds: string[] = [];

  for (const ride of ridesForCancel) {
    const departureMs = new Date(
      `${ride.departureDate}T${ride.departureTime}:00`
    ).getTime();

    const hoursUntilDeparture = (departureMs - now.getTime()) / 3600000;

    if (hoursUntilDeparture <= cancelHours) {
      cancelRideIds.push(ride._id.toString());
    }
  }

  if (!cancelRideIds.length) return;

  // Bulk cancel rides
  await Ride.updateMany(
    { _id: { $in: cancelRideIds }, status: RIDE_STATUS.pending },
    {
      status: RIDE_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
      cancelledAt: now,
    }
  );

  // Bulk cancel passengers
  await Passenger.updateMany(
    { rideId: { $in: cancelRideIds }, status: PASSENGER_STATUS.pending },
    {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
    }
  );

  // Notify riders — cancelled
  const cancelledPassengers = await Passenger.find(
    { rideId: { $in: cancelRideIds }, cancellationReason: 'no_driver_found' },
    'userId rideId'
  ).lean();

  for (const p of cancelledPassengers) {
    // Socket
    io.to(`user:${p.userId}`).emit('ride:no-driver-found', {
      rideId: p.rideId,
      message: 'No driver accepted your ride. Booking has been cancelled.',
      retryAfter: 5,
    });

    // ✅ FCM push — no driver found, cancelled
    const riderUser = await User.findById(p.userId).select('fcmToken').lean();
    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver: p.userId,
        message: 'Ride Cancelled — No Driver Found',
        description: `No driver was available for your ride. Your booking has been cancelled.`,
        reference: p.rideId.toString(),
        modelType: modeType.Ride,
      }).catch(() => {});
    }
  }

  // Redis cleanup
  const multi = redis.multi();
  for (const rideId of cancelRideIds) {
    multi.zrem('ride:matching:queue', rideId);
    multi.del(`ride:request:${rideId}`);
  }
  await multi.exec();

  console.log(`🚫 No driver found: cancelled ${cancelRideIds.length} ride(s)`);
};
