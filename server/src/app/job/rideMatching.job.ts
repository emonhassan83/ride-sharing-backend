// jobs/rideMatching.job.ts
import { Ride } from '../modules/ride/ride.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { Booking } from '../modules/booking/booking.model';
import { PAYMENT_STATUS as BOOKING_PAYMENT_STATUS } from '../modules/booking/booking.constant';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { getRedisClient } from '../config/redis.config';
import { getIO } from '../socket/socket.init';
import { notifyNearbyDrivers } from '../utils/notifyDrivers.utils';
import { User } from '../modules/user/user.model';
import { toLuggageFyiView } from '../utils/luggage.utils';
import { notifyUserPush } from '../utils/notifyUser.utils';
import { modeType } from '../modules/notification/notification.interface';
import { formatRideLocalDate } from '../utils/rideSchedule.utils';

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
        $gte: formatRideLocalDate(in47h),
        $lte: formatRideLocalDate(in48h),
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

      const paidBooking = await Booking.findOne({
        passengerId: passenger._id,
        paymentStatus: {
          $in: [BOOKING_PAYMENT_STATUS.authorized, BOOKING_PAYMENT_STATUS.paid],
        },
      })
        .select('_id')
        .lean();
      if (!paidBooking) continue;

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
        rideType:            ride.type,
        vehicleType:         (ride as any).vehicleType || null,
        requestedSeats:      ride.totalSeats,
        estimatedFare:       (passenger as any).estimatedFare       || 0,
        estimatedDistanceKm: (passenger as any).estimatedDistanceKm || 0,
        status:              PASSENGER_STATUS.pending,
        createdAt:           (passenger as any).createdAt,
        ...toLuggageFyiView(passenger),
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
        $gte: formatRideLocalDate(in23h),
        $lte: formatRideLocalDate(in24h),
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

      const cancelledPassengers = await Passenger.find({
        rideId: ride._id,
        status: PASSENGER_STATUS.pending,
      }).select('_id userId');

      await Passenger.updateMany(
        { rideId: ride._id, status: PASSENGER_STATUS.pending },
        {
          status: PASSENGER_STATUS.cancelled,
          cancellationReason: 'no_driver_accepted',
        }
      );

      const cancelMessage =
        'No driver accepted your ride within 24 hours of departure. Your ride has been cancelled.';

      for (const p of cancelledPassengers) {
        const userId = p.userId?.toString();
        if (!userId) continue;

        io.to(`user:${userId}`).emit('ride:cancelled-no-driver', {
          rideId: ride._id,
          message: cancelMessage,
        });

        await notifyUserPush({
          userId,
          message: 'Ride Cancelled — No Driver',
          description: cancelMessage,
          reference: ride._id.toString(),
          modelType: modeType.Ride,
          data: {
            type: 'RIDE_CANCELLED_NO_DRIVER',
            rideId: String(ride._id),
          },
        });
      }

      await redis.set(`ride:final-check:${ride._id}`, '1', 'EX', 25 * 3600);

      console.log(`❌ Phase 3: Ride ${ride._id} auto-cancelled (no driver)`);
    }
  } catch (err) {
    console.error('❌ Ride matching job error:', err);
  }
};