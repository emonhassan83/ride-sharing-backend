// utils/triggerArrival.ts
import { Types } from 'mongoose';
import { PASSENGER_STATUS } from '../../modules/passenger/passenger.constant';
import { Passenger } from '../../modules/passenger/passenger.model';
import { Ride } from '../../modules/ride/ride.model';
import { User } from '../../modules/user/user.model';
import { modeType } from '../../modules/notification/notification.interface';
import { sendNotification } from '../../utils/sentPushNotification';
import { getWaitingRatePerMinute, isNightFare } from '../../utils/waitingCharge.utils';


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

    const ride = await Ride.findById(rideId).select('departureTime').lean();
    const night = isNightFare(ride?.departureTime ?? '08:00');
    const waitingRatePerMinute = await getWaitingRatePerMinute(night);

    await redis.set(`ride:${rideId}:lastArrivalNotify`, Date.now().toString(), 'EX', 60);

    passenger.arriveAt        = new Date();
    passenger.arrivedNotified = true;
    passenger.status          = PASSENGER_STATUS.driver_arrived;
    await passenger.save();

    console.log(`✅ Passenger ${passengerId} → driver_arrived`);

    await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
      driverId,
      event:       'ARRIVED_AT_PICKUP',
      passengerId: passenger._id,
      lat, lng,
      timestamp:   Date.now(),
    }));

    // ── Socket notify ─────────────────────────────────────────────────────────
    io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
      rideId,
      passengerId:  passenger._id,
      driverId,
      message:      'Your driver has arrived at your pickup location',
      waitingTime:  2,
      autoDetected: true,
    });

    // ✅ Push notification — driver arrived
    const riderUser = await User.findById(passenger.userId)
      .select('fcmToken')
      .lean();

    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver:    passenger.userId,
        message:     'Driver Has Arrived!',
        description: 'Your driver is at your pickup location. Please be ready within minutes.',
        reference:   rideId,
        modelType:   modeType.Ride,
      }).catch((err: any) => console.warn(`FCM failed for rider ${passenger.userId}:`, err));
    }

    const remaining = await Passenger.countDocuments({
      rideId,
      status:          PASSENGER_STATUS.confirmed,
      arrivedNotified: false,
    });

    if (remaining === 0) {
      io.to(`ride:${rideId}`).emit('ride:all-passengers-arrived', {
        rideId,
        message: 'Driver has arrived at all pickup locations.',
      });
    }

    // ── 2 min grace — then waiting charge starts ──────────────────────────────
    setTimeout(async () => {
      const p = await Passenger.findById(passengerId);
      if (!p || p.pickedUpAt || p.status === PASSENGER_STATUS.picked_up) {
        console.log(`✅ Passenger ${passengerId} already picked up — no waiting charge`);
        return;
      }

      const waitingStartedAt = new Date();
      await Passenger.findByIdAndUpdate(passengerId, { waitingStartedAt });

      // Socket
      io.to(`user:${passenger.userId}`).emit('ride:waiting-charge-started', {
        rideId,
        passengerId:  passenger._id,
        ratePerMinute: waitingRatePerMinute,
        ratePerHour:   Math.round(waitingRatePerMinute * 60 * 100) / 100,
        startedAt:     waitingStartedAt,
        message:       `Waiting charge started: £${waitingRatePerMinute.toFixed(4)}/min`,
      });

      io.to(`driver:${driverId}`).emit('ride:waiting-charge-active', {
        rideId,
        passengerId: passenger._id,
        message:     'Waiting charge is now active for this passenger.',
      });

      // ✅ Push notification — waiting charge started
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver:    passenger.userId,
          message:     'Waiting Charge Started!',
          description: `Your driver is waiting. Charge: £${waitingRatePerMinute.toFixed(4)}/min. Please arrive ASAP.`,
          reference:   rideId,
          modelType:   modeType.Ride,
        }).catch((err: any) => console.warn(`FCM waiting charge notify failed:`, err));
      }

      console.log(`⏱️ Waiting charge started for passenger ${passengerId} | rate: £${waitingRatePerMinute}/min`);
    }, 2 * 60 * 1000);

    console.log(`✅ Auto-arrival triggered: ride=${rideId}, passenger=${passengerId}`);
  } catch (error) {
    console.error('❌ Error in triggerArrival:', error);
  }
}