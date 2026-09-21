// utils/triggerArrival.ts
import { Types } from 'mongoose';
import { PASSENGER_STATUS } from '../../modules/passenger/passenger.constant';
import { Passenger } from '../../modules/passenger/passenger.model';
import { User } from '../../modules/user/user.model';
import { modeType } from '../../modules/notification/notification.interface';
import { sendNotification } from '../../utils/sentPushNotification';
import { buildWaitTimeNotice } from '../../utils/waitTimeNotice.utils';

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
      console.log(`triggerArrival: passenger ${passengerId} not found`);
      return;
    }
    if (passenger.arrivedNotified) {
      console.log(`triggerArrival: passenger ${passengerId} already notified`);
      return;
    }

    const waitNotice = buildWaitTimeNotice();

    await redis.set(`ride:${rideId}:lastArrivalNotify`, Date.now().toString(), 'EX', 60);

    passenger.arriveAt = new Date();
    passenger.arrivedNotified = true;
    passenger.status = PASSENGER_STATUS.driver_arrived;
    await passenger.save();

    await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
      driverId,
      event: 'ARRIVED_AT_PICKUP',
      passengerId: passenger._id,
      lat,
      lng,
      timestamp: Date.now(),
    }));

    io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
      rideId,
      passengerId: passenger._id,
      driverId,
      message: 'Your driver has arrived at your pickup location',
      waitingTime: waitNotice.maxWaitMinutes,
      waitTimeNotice: waitNotice,
      autoDetected: true,
    });

    const riderUser = await User.findById(passenger.userId)
      .select('fcmToken')
      .lean();

    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver: passenger.userId,
        message: 'Driver Has Arrived!',
        description: waitNotice.message,
        reference: rideId,
        modelType: modeType.Ride,
      }).catch((err: any) => console.warn(`FCM failed for rider ${passenger.userId}:`, err));
    }

    const remaining = await Passenger.countDocuments({
      rideId,
      status: PASSENGER_STATUS.confirmed,
      arrivedNotified: false,
    });

    if (remaining === 0) {
      io.to(`ride:${rideId}`).emit('ride:all-passengers-arrived', {
        rideId,
        message: 'Driver has arrived at all pickup locations.',
      });
    }

    // Dummy wait notice only — does NOT start a charge or change locked fare.
    setTimeout(async () => {
      const p = await Passenger.findById(passengerId);
      if (!p || p.pickedUpAt || p.status === PASSENGER_STATUS.picked_up) {
        return;
      }

      io.to(`user:${passenger.userId}`).emit('ride:wait-time-notice', {
        rideId,
        passengerId: passenger._id,
        ...waitNotice,
      });

      io.to(`driver:${driverId}`).emit('ride:wait-time-notice', {
        rideId,
        passengerId: passenger._id,
        ...waitNotice,
      });

      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Please Board Soon',
          description: waitNotice.message,
          reference: rideId,
          modelType: modeType.Ride,
        }).catch(() => {});
      }
    }, waitNotice.maxWaitMinutes * 60 * 1000);

    console.log(`Auto-arrival triggered: ride=${rideId}, passenger=${passengerId}`);
  } catch (error) {
    console.error('Error in triggerArrival:', error);
  }
}
