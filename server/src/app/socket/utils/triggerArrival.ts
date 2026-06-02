// utils/triggerArrival.ts
import { Types } from 'mongoose';
import { PASSENGER_STATUS } from '../../modules/passenger/passenger.constant';
import { Passenger } from '../../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../../modules/ride/ride.constant';
import { Ride } from '../../modules/ride/ride.model';

export async function triggerArrival(
  rideId: string,
  passengerId: string | Types.ObjectId,
  driverId: string,
  lat: number,
  lng: number,
  io: any,
  redis: any,
) {
  try {
    const passenger = await Passenger.findById(passengerId);
    if (!passenger) {
      console.log(`❌ triggerArrival: passenger ${passengerId} not found`);
      return;
    }

    // ── Already notified guard ─────────────────────────────────────────────
    if (passenger.arrivedNotified) {
      console.log(`⏭️ triggerArrival: passenger ${passengerId} already notified`);
      return;
    }

    // ── Set cooldown FIRST to prevent duplicate triggers ───────────────────
    await redis.set(
      `ride:${rideId}:lastArrivalNotify`,
      Date.now().toString(),
      'EX',
      60,
    );

    // ── Update passenger ───────────────────────────────────────────────────
    passenger.arriveAt = new Date();
    passenger.arrivedNotified = true;
    await passenger.save();
    console.log(`✅ Passenger ${passengerId} → arrivedNotified: true`);

    // ── Redis event log — use valid enum value ─────────────────────────────
    await redis.rpush(
      `ride:${rideId}:live`,
      JSON.stringify({
        driverId,
        passengerId,
        event: 'ARRIVED_AT_PICKUP', // ✅ fixed — was ARRIVED_AT_PICKUP_GEOFENCE
        lat,
        lng,
        timestamp: Date.now(),
      }),
    );

    // ── Notify passenger ───────────────────────────────────────────────────
    const socketRoom = `user:${passenger.userId}`;
    console.log(`📢 Emitting ride:driver-arrived → ${socketRoom}`);

    io.to(socketRoom).emit('ride:driver-arrived', {
      rideId,
      passengerId: passenger._id,
      driverId,
      message: 'Your driver has arrived at your pickup location',
      waitingTime: 2,
      autoDetected: true,
    });

    // ── Check if all passengers notified ──────────────────────────────────
    const remaining = await Passenger.countDocuments({
      rideId,
      status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
      arrivedNotified: false, // ✅ fixed — was arriveAt: { $exists: false }
    });

    console.log(`📊 Remaining unnotified passengers: ${remaining}`);

    if (remaining === 0) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.driver_arrived,
        arrivedAt: new Date(),
      });
      console.log(`✅ Ride ${rideId} → driver_arrived`);

      io.to(`ride:${rideId}`).emit('ride:all-passengers-arrived', {
        rideId,
        message: 'Driver has arrived at all pickup locations',
      });
    }

    // ── Waiting charge timer ───────────────────────────────────────────────
    setTimeout(async () => {
      const p = await Passenger.findById(passengerId);
      if (p?.arriveAt && !p?.pickedUpAt) {
        io.to(socketRoom).emit('ride:waiting-charge', {
          rideId,
          passengerId,
          message: 'Waiting charges will apply after 2 minutes',
        });
      }
    }, 180000);

    console.log(`✅ Auto-arrival triggered: ride=${rideId}, passenger=${passengerId}`);
  } catch (error) {
    console.error('❌ Error in triggerArrival:', error);
  }
}