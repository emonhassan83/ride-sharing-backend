// utils/triggerArrival.ts
import { Types } from 'mongoose';
import { PASSENGER_STATUS } from '../../modules/passenger/passenger.constant';
import { Passenger } from '../../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../../modules/ride/ride.constant';
import { Ride } from '../../modules/ride/ride.model';
import { getWaitingRatePerMinute } from '../../utils/waitingCharge.utils';

export async function triggerArrival(
  rideId:      string,
  passengerId: string | Types.ObjectId,
  driverId:    string,
  lat:         number,
  lng:         number,
  io:          any,
  redis:       any,
) {
  try {
    const passenger = await Passenger.findById(passengerId);
    if (!passenger) {
      console.log(`❌ triggerArrival: passenger ${passengerId} not found`);
      return;
    }

    if (passenger.arrivedNotified) {
      console.log(`⏭️ triggerArrival: passenger ${passengerId} already notified`);
      return;
    }

    // ── Set cooldown ──────────────────────────────────────────────────────────
    await redis.set(`ride:${rideId}:lastArrivalNotify`, Date.now().toString(), 'EX', 60);

    // ── Update passenger ──────────────────────────────────────────────────────
    passenger.arriveAt        = new Date();
    passenger.arrivedNotified = true;
    passenger.status          = PASSENGER_STATUS.driver_arrived;
    await passenger.save();

    console.log(`✅ Passenger ${passengerId} → driver_arrived`);

    // ── Redis event log ───────────────────────────────────────────────────────
    await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
      driverId,
      event:       'ARRIVED_AT_PICKUP',
      passengerId: passenger._id,
      lat, lng,
      timestamp:   Date.now(),
    }));

    // ── Notify passenger ──────────────────────────────────────────────────────
    io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
      rideId,
      passengerId:  passenger._id,
      driverId,
      message:      'Your driver has arrived at your pickup location',
      waitingTime:  2,
      autoDetected: true,
    });

    // ── Check all passengers notified → update ride status ────────────────────
    const remaining = await Passenger.countDocuments({
      rideId,
      status:          PASSENGER_STATUS.confirmed,
      arrivedNotified: false,
    });

    if (remaining === 0) {
      // await Ride.findByIdAndUpdate(rideId, {
      //   status:    RIDE_STATUS.driver_arrived,
      //   arrivedAt: new Date(),
      // });
      io.to(`ride:${rideId}`).emit('ride:all-passengers-arrived', {
        rideId,
        message: 'Driver has arrived at all pickup locations.',
      });
    }

    // ── ✅ Waiting charge starts after 2 min grace period ─────────────────────
    setTimeout(async () => {
      const p = await Passenger.findById(passengerId);

      // Already picked up — no waiting charge needed
      if (!p || p.pickedUpAt || p.status === PASSENGER_STATUS.picked_up) {
        console.log(`✅ Passenger ${passengerId} already picked up — no waiting charge`);
        return;
      }

      // Passenger still waiting — start charge
      const waitingStartedAt = new Date();
      const waitingRate      = await getWaitingRatePerMinute();

      await Passenger.findByIdAndUpdate(passengerId, { waitingStartedAt });

      // Notify rider
      io.to(`user:${passenger.userId}`).emit('ride:waiting-charge-started', {
        rideId,
        passengerId:   passenger._id,
        ratePerMinute: waitingRate,
        startedAt:     waitingStartedAt,
        message:       `Waiting charge started: £${waitingRate}/min`,
      });

      // Notify driver
      io.to(`driver:${driverId}`).emit('ride:waiting-charge-active', {
        rideId,
        passengerId: passenger._id,
        message:     'Waiting charge is now active for this passenger.',
      });

      console.log(`⏱️ Waiting charge started for passenger ${passengerId} | rate: £${waitingRate}/min`);
    }, 2 * 60 * 1000); // 2 min grace

    console.log(`✅ Auto-arrival triggered: ride=${rideId}, passenger=${passengerId}`);
  } catch (error) {
    console.error('❌ Error in triggerArrival:', error);
  }
}