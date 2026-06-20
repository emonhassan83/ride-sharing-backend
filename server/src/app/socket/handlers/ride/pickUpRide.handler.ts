// handlers/driver/pickUpRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import {
  calculateWaitingCharge,
  deductWaitingCharge,
  getWaitingRatePerMinute,
  isNightFare,
} from '../../../utils/waitingCharge.utils';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';
import { User } from '../../../modules/user/user.model';

export const pickUpRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });
    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: 'Trip must be started before picking up' });

    const redis = getRedisClient();
    const io    = getIO();

    const night = isNightFare(ride.departureTime ?? '08:00');
    const waitingRatePerMinute = await getWaitingRatePerMinute(night);

    const doPickup = async (passenger: any) => {
      const pickedUpAt   = new Date();
      let waitingCharge  = 0;
      let paymentResult: any = { method: 'none', amount: 0 };

      if (passenger.waitingStartedAt && !passenger.waitingChargePaid) {
        waitingCharge = calculateWaitingCharge(
          passenger.waitingStartedAt,
          pickedUpAt,
          waitingRatePerMinute,
        );

        if (waitingCharge > 0) {
          paymentResult = await deductWaitingCharge(
            passenger.userId.toString(),
            waitingCharge,
            rideId,
          ) as any;
        }
      }

      await Passenger.findByIdAndUpdate(passenger._id, {
        status:            PASSENGER_STATUS.picked_up,
        pickedUpAt,
        waitingCharge,
        waitingChargePaid: waitingCharge > 0,
      });

      const pickupPayload = {
        rideId,
        passengerId:   passenger._id,
        driverId,
        pickedUpAt,
        waitingCharge,
        paymentMethod: paymentResult.method,
        message:       'You have been picked up!',
      };

      // ✅ Rider এ notify — user room (reliable, rider always in this room)
      io.to(`user:${passenger.userId}`).emit('ride:passenger-picked-up', pickupPayload);
      // ✅ ride room এও emit (rider যদি ride room এ থাকে)
      io.to(`ride:${rideId}`).emit('ride:passenger-picked-up', pickupPayload);

      // FCM — rider
      const riderUser = await User.findById(passenger.userId).select('fcmToken').lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver:    passenger.userId,
          message:     'You Have Been Picked Up!',
          description: waitingCharge > 0
            ? `Waiting charge of £${waitingCharge} has been deducted from your ${paymentResult.method}.`
            : 'Driver has picked you up. Safe journey!',
          reference:   rideId,
          modelType:   modeType.Ride,
        }).catch(() => {});
      }

      // FCM — driver
      const driverUser = await User.findById(driverId).select('fcmToken').lean();
      if (driverUser?.fcmToken) {
        sendNotification([driverUser.fcmToken], {
          receiver:    driverId,
          message:     'Passenger Picked Up',
          description: waitingCharge > 0
            ? `Passenger picked up. Waiting charge £${waitingCharge} received.`
            : 'Passenger has been successfully picked up.',
          reference:   rideId,
          modelType:   modeType.Ride,
        }).catch(() => {});
      }

      await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
        event:       'PASSENGER_PICKED_UP',
        driverId,
        passengerId: passenger._id,
        timestamp:   Date.now(),
      }));

      return { waitingCharge, paymentResult };
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: { $in: [PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.in_progress] },
      });
      if (!passenger)
        return callback?.({ success: false, message: 'No passenger to pick up' });

      const { waitingCharge, paymentResult } = await doPickup(passenger);

      return callback?.({
        success: true,
        message: 'Passenger picked up successfully',
        data:    { passengerId: passenger._id, waitingCharge, paymentMethod: paymentResult.method },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        status: { $in: [PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.in_progress] },
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already picked up' });

      const { waitingCharge, paymentResult } = await doPickup(passenger);

      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.driver_arrived,
      });

      if (remainingCount > 0) {
        io.to(`driver:${driverId}`).emit('ride:passenger-picked', {
          rideId,
          passengerId:         passenger._id,
          remainingPassengers: remainingCount,
        });
      } else {
        io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
          rideId,
          message: 'All passengers picked up. Ready to go!',
        });
      }

      return callback?.({
        success: true,
        message: 'Passenger picked up successfully',
        data: {
          passengerId:         passenger._id,
          waitingCharge,
          paymentMethod:       paymentResult.method,
          remainingPassengers: remainingCount,
          allPickedUp:         remainingCount === 0,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);