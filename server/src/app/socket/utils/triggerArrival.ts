// utils/triggerArrival.ts
import { Types } from 'mongoose';
import { PASSENGER_STATUS } from '../../modules/passenger/passenger.constant';
import { Passenger } from '../../modules/passenger/passenger.model';
import { modeType } from '../../modules/notification/notification.interface';
import { notifyUserPush } from '../../utils/notifyUser.utils';
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
    const passenger = await Passenger.findOneAndUpdate(
      { _id: passengerId, arrivedNotified: { $ne: true } },
      {
        $set: {
          arriveAt: new Date(),
          arrivedNotified: true,
          status: PASSENGER_STATUS.driver_arrived,
        },
      },
      { returnDocument: 'after' },
    );
    if (!passenger) {
      console.log(`triggerArrival: passenger ${passengerId} already notified or not found`);
      return;
    }

    const waitNotice = buildWaitTimeNotice();

    await redis.set(`ride:${rideId}:lastArrivalNotify`, Date.now().toString(), 'EX', 60);

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

    await notifyUserPush({
      userId: passenger.userId.toString(),
      message: 'Driver Has Arrived!',
      description: waitNotice.message,
      reference: rideId,
      modelType: modeType.Ride,
      dedupeKey: `driver-arrived:${passenger._id.toString()}`,
      data: {
        type: 'DRIVER_ARRIVED',
        rideId: String(rideId),
        passengerId: passenger._id.toString(),
      },
    });

    const remaining = await Passenger.countDocuments({
      rideId,
      status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.in_progress] },
      arrivedNotified: false,
    });

    if (remaining === 0) {
      io.to(`ride:${rideId}`).emit('ride:all-passengers-arrived', {
        rideId,
        message: 'Driver has arrived at all pickup locations.',
      });
    }

    // Warning only — does NOT start a charge or change locked fare.
    setTimeout(async () => {
      const p = await Passenger.findById(passengerId);
      if (!p || p.pickedUpAt || p.status !== PASSENGER_STATUS.driver_arrived) {
        return;
      }

      const followUpNotice = buildWaitTimeNotice('follow_up');

      io.to(`user:${passenger.userId}`).emit('ride:wait-time-notice', {
        rideId,
        passengerId: passenger._id,
        ...followUpNotice,
      });

      io.to(`driver:${driverId}`).emit('ride:wait-time-notice', {
        rideId,
        passengerId: passenger._id,
        ...followUpNotice,
      });

      await notifyUserPush({
        userId: passenger.userId.toString(),
        message: 'Please Board Soon',
        description: followUpNotice.message,
        reference: rideId,
        modelType: modeType.Ride,
        dedupeKey: `board-soon:${passenger._id.toString()}`,
        data: {
          type: 'BOARD_SOON',
          rideId: String(rideId),
          passengerId: passenger._id.toString(),
        },
      });
    }, waitNotice.maxWaitMinutes * 60 * 1000);

    console.log(`Auto-arrival triggered: ride=${rideId}, passenger=${passengerId}`);
  } catch (error) {
    console.error('Error in triggerArrival:', error);
  }
}
