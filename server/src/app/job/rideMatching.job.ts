// jobs/rideMatching.job.ts
import cron from 'node-cron';
import { Ride } from '../modules/ride/ride.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { getRedisClient } from '../config/redis.config';
import { getIO } from '../socket/socket.init';
import { notifyNearbyDrivers } from '../utils/notifyDrivers.utils';
import { User } from '../modules/user/user.model';

let matchingJobRunning = false;

export function startRideMatchingJob() {
  // Every hour
  cron.schedule('0 * * * *', async () => {
    if (matchingJobRunning) return;
    matchingJobRunning = true;

    try {
      const now       = new Date();
      const redis     = getRedisClient();
      const io        = getIO();

      // ── Phase 2: 48h before departure — re-notify ─────────────────────────
      const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const in47h = new Date(now.getTime() + 47 * 60 * 60 * 1000);

      const phase2Rides = await Ride.find({
        status:        RIDE_STATUS.pending,
        departureDate: {
          $gte: in47h.toISOString().split('T')[0],
          $lte: in48h.toISOString().split('T')[0],
        },
      }).lean();

      for (const ride of phase2Rides) {
        // Check if already re-notified
        const alreadyRenotified = await redis.get(`ride:renotified:48h:${ride._id}`);
        if (alreadyRenotified) continue;

        const passenger = await Passenger.findOne({
          rideId: ride._id,
          status: PASSENGER_STATUS.pending,
        }).lean();
        if (!passenger) continue;

        const rider = await User.findById(ride.rideCreatedBy)
          .select('name profileImage avgRating phone')
          .lean();

        const ridePayload = {
          rideId:        ride._id.toString(),
          passengerId:   passenger._id.toString(),
          riderInfo: {
            name:         rider?.name         || '',
            profileImage: rider?.profileImage || null,
            avgRating:    rider?.avgRating    || 0,
          },
          rideType:      ride.type,
          pickup:        { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0], address: ride.pickup.address },
          destination:   { lat: ride.destination.coordinates[1], lng: ride.destination.coordinates[0], address: ride.destination.address },
          requestedSeats: ride.totalSeats,
          estimatedFare:  passenger.estimatedFare,
          departureDate:  ride.departureDate,
          departureTime:  ride.departureTime,
          phase:          2,
          message:        'Ride departing in 48 hours — accept now!',
        };

        const count = await notifyNearbyDrivers(
          ride._id.toString(),
          { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] },
          ridePayload,
          redis,
          io,
        );

        // Mark as re-notified
        await redis.set(`ride:renotified:48h:${ride._id}`, '1', 'EX', 50 * 3600);
        console.log(`🔔 Phase 2: Re-notified ${count} driver(s) for ride ${ride._id}`);
      }

      // ── Phase 3: 24h before departure — final check → cancel if no driver ──
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);

      const phase3Rides = await Ride.find({
        status:        RIDE_STATUS.pending,
        departureDate: {
          $gte: in23h.toISOString().split('T')[0],
          $lte: in24h.toISOString().split('T')[0],
        },
      }).lean();

      for (const ride of phase3Rides) {
        const alreadyCancelled = await redis.get(`ride:final-check:${ride._id}`);
        if (alreadyCancelled) continue;

        // Cancel ride — no driver accepted in 24h window
        await Ride.findByIdAndUpdate(ride._id, {
          status:             RIDE_STATUS.cancelled,
          cancellationReason: 'no_driver_accepted_within_24h',
          cancelledAt:        new Date(),
        });

        await Passenger.updateMany(
          { rideId: ride._id, status: PASSENGER_STATUS.pending },
          { status: PASSENGER_STATUS.cancelled, cancellationReason: 'no_driver_accepted' },
        );

        // Notify rider
        io.to(`user:${ride.rideCreatedBy}`).emit('ride:cancelled-no-driver', {
          rideId:  ride._id,
          message: 'No driver accepted your ride within 24 hours of departure. Your ride has been cancelled.',
        });

        // FCM to rider
        const riderUser = await User.findById(ride.rideCreatedBy).select('fcmToken').lean();
        if (riderUser?.fcmToken) {
        //   await sendPushNotification({
        //     fcmToken: riderUser.fcmToken,
        //     title:    'Ride Cancelled',
        //     body:     'No driver accepted your ride within 24 hours of departure.',
        //     data:     { type: 'RIDE_CANCELLED', rideId: ride._id.toString() },
        //   }).catch(() => {});
        }

        await redis.set(`ride:final-check:${ride._id}`, '1', 'EX', 25 * 3600);
        console.log(`❌ Phase 3: Ride ${ride._id} cancelled — no driver accepted`);
      }

    } catch (err) {
      console.error('❌ Ride matching job error:', err);
    } finally {
      matchingJobRunning = false;
    }
  });

  console.log('✅ Ride matching job started (hourly)');
}