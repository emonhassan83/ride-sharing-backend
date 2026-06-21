// jobs/rideMatching.job.ts
import { Ride } from '../modules/ride/ride.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { getRedisClient } from '../config/redis.config';
import { getIO } from '../socket/socket.init';
import { notifyNearbyDrivers } from '../utils/notifyDrivers.utils';
import { User } from '../modules/user/user.model';

export const startRideMatchingJob = async (): Promise<void> => {
  try {
    const now = new Date();
    const redis = getRedisClient();
    const io = getIO();

    // ── Phase 2: 48h before departure — Re-notify drivers ─────────────────
    const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const in47h = new Date(now.getTime() + 47 * 60 * 60 * 1000);

    const phase2Rides = await Ride.find({
      status: RIDE_STATUS.pending,
      departureDate: {
        $gte: in47h.toISOString().split('T')[0],
        $lte: in48h.toISOString().split('T')[0],
      },
    }).lean();

    for (const ride of phase2Rides) {
      const alreadyRenotified = await redis.get(`ride:renotified:48h:${ride._id}`);
      if (alreadyRenotified) continue;

      const passenger = await Passenger.findOne({
        rideId: ride._id,
        status: PASSENGER_STATUS.pending,
      }).lean();

      if (!passenger) continue;

      const rider = await User.findById(ride.rideCreatedBy)
        .select('name profileImage')
        .lean();

      const ridePayload = {
        _id:  passenger._id,
        userId: {
          _id:          rider?._id          || null,
          name:         rider?.name         || '',
          profileImage: rider?.profileImage || null,
        },
        rideId: {
          _id:  ride._id,
          type: ride.type,
          id:   (ride as any).id || '',
        },
        pickup: {
          address:     ride.pickup.address,
          coordinates: ride.pickup.coordinates,
        },
        destination: {
          address:     ride.destination.address,
          coordinates: ride.destination.coordinates,
        },
        departureDate:       ride.departureDate,
        departureTime:       ride.departureTime,
        requestedSeats:      ride.totalSeats,
        estimatedFare:       (passenger as any).estimatedFare       || 0,
        estimatedDistanceKm: (passenger as any).estimatedDistanceKm || 0,
        status:              PASSENGER_STATUS.pending,
        createdAt:           (passenger as any).createdAt,
      };

      const count = await notifyNearbyDrivers(
        ride._id.toString(),
        { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] },
        ridePayload,
        redis,
        io
      );

      await redis.set(`ride:renotified:48h:${ride._id}`, '1', 'EX', 50 * 3600);

      console.log(`🔔 Phase 2: Re-notified ${count} driver(s) for ride ${ride._id}`);
    }

    // ── Phase 3: 24h before departure — Final check & auto cancel ─────────
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);

    const phase3Rides = await Ride.find({
      status: RIDE_STATUS.pending,
      departureDate: {
        $gte: in23h.toISOString().split('T')[0],
        $lte: in24h.toISOString().split('T')[0],
      },
    }).lean();

    for (const ride of phase3Rides) {
      const alreadyChecked = await redis.get(`ride:final-check:${ride._id}`);
      if (alreadyChecked) continue;

      await Ride.findByIdAndUpdate(ride._id, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: 'no_driver_accepted_within_24h',
        cancelledAt: new Date(),
      });

      await Passenger.updateMany(
        { rideId: ride._id, status: PASSENGER_STATUS.pending },
        {
          status: PASSENGER_STATUS.cancelled,
          cancellationReason: 'no_driver_accepted',
        }
      );

      io.to(`user:${ride.rideCreatedBy}`).emit('ride:cancelled-no-driver', {
        rideId: ride._id,
        message: 'No driver accepted your ride within 24 hours of departure. Your ride has been cancelled.',
      });

      await redis.set(`ride:final-check:${ride._id}`, '1', 'EX', 25 * 3600);

      console.log(`❌ Phase 3: Ride ${ride._id} auto-cancelled (no driver)`);
    }
  } catch (err) {
    console.error('❌ Ride matching job error:', err);
  }
};