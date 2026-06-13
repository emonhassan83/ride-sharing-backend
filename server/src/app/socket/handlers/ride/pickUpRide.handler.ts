// handlers/driver/pickUpRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import {
  calculateWaitingCharge,
  deductWaitingCharge,
  getWaitingRatePerMinute,
} from '../../../utils/waitingCharge.utils';

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

    // ── Helper: pickup + stop waiting charge ──────────────────────────────────
    const doPickup = async (passenger: any) => {
      const pickedUpAt = new Date();

      // ✅ Stop waiting charge — calculate if waiting was active
      let waitingCharge = 0;
      let paymentResult = { method: 'none', amount: 0 };

      if (passenger.waitingStartedAt && !passenger.waitingChargePaid) {
        const rate    = await getWaitingRatePerMinute();
        waitingCharge = calculateWaitingCharge(
          passenger.waitingStartedAt,
          pickedUpAt,
          rate,
        );

        if (waitingCharge > 0) {
          // ✅ Deduct waiting charge immediately at pickup
          paymentResult = await deductWaitingCharge(
            passenger.userId.toString(),
            waitingCharge,
            rideId,
          );

          // Notify rider about waiting charge
          io.to(`user:${passenger.userId}`).emit('ride:waiting-charge-paid', {
            rideId,
            passengerId:    passenger._id,
            waitingCharge,
            paymentMethod:  paymentResult.method,
            message:        `Waiting charge of £${waitingCharge} deducted from your ${paymentResult.method}.`,
          });

          console.log(`💰 Waiting charge £${waitingCharge} deducted via ${paymentResult.method} for passenger ${passenger._id}`);
        }
      }

      // ✅ Update passenger
      await Passenger.findByIdAndUpdate(passenger._id, {
        status:            PASSENGER_STATUS.picked_up,
        pickedUpAt,
        waitingCharge,
        waitingChargePaid: waitingCharge > 0,
      });

      await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
        event:          'PASSENGER_PICKED_UP',
        driverId,
        passengerId:    passenger._id,
        timestamp:      Date.now(),
        waitingCharge,
      }));

      return { waitingCharge, paymentResult };
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId, status: PASSENGER_STATUS.in_progress,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'No passenger to pick up' });

      const { waitingCharge, paymentResult } = await doPickup(passenger);

      io.to(`ride:${rideId}`).emit('ride:passenger-picked-up', {
        rideId,
        passengerId:   passenger._id,
        driverId,
        pickedUpAt:    new Date(),
        waitingCharge,
        paymentMethod: paymentResult.method,
        message:       'You have been picked up!',
      });

      io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
        rideId, message: 'All passengers picked up.', passengerCount: 1,
      });

      return callback?.({
        success: true,
        message: 'Passenger picked up successfully',
        data:    { passengerId: passenger._id, waitingCharge, allPickedUp: true },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required' });

      const passenger = await Passenger.findOne({
        _id: passengerId, rideId, status: PASSENGER_STATUS.in_progress,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already picked up' });

      const { waitingCharge, paymentResult } = await doPickup(passenger);

      io.to(`user:${passenger.userId}`).emit('ride:passenger-picked-up', {
        rideId,
        passengerId:   passenger._id,
        driverId,
        pickedUpAt:    new Date(),
        waitingCharge,
        paymentMethod: paymentResult.method,
        message:       'You have been picked up!',
      });

      const remainingCount = await Passenger.countDocuments({
        rideId, status: PASSENGER_STATUS.in_progress,
      });

      if (remainingCount > 0) {
        const others = await Passenger.find({
          rideId, _id: { $ne: passengerId }, status: PASSENGER_STATUS.in_progress,
        }).select('userId');

        for (const op of others) {
          io.to(`user:${op.userId}`).emit('ride:co-passenger-picked', {
            rideId, pickedUpPassengerId: passenger._id,
            remainingPassengers: remainingCount,
            message: 'A fellow passenger has been picked up.',
          });
        }

        io.to(`driver:${driverId}`).emit('ride:passenger-picked', {
          rideId, passengerId: passenger._id,
          remainingPassengers: remainingCount,
          message: `${remainingCount} passenger(s) remaining.`,
        });

        return callback?.({
          success: true,
          message: `Passenger picked up. ${remainingCount} remaining.`,
          data:    { passengerId: passenger._id, waitingCharge, remainingPassengers: remainingCount, allPickedUp: false },
        });
      }

      io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
        rideId, message: 'All passengers picked up.',
      });

      return callback?.({
        success: true,
        message: 'Last passenger picked up. All on board!',
        data:    { passengerId: passenger._id, waitingCharge, remainingPassengers: 0, allPickedUp: true },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);