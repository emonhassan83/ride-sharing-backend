// handlers/driver/pickUpRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { modeType } from '../../../modules/notification/notification.interface';
import { computePickupDelay } from '../../../utils/waitTimeNotice.utils';

/** Still waiting to be picked up (not yet onboard). */
const WAITING_PICKUP_STATUSES = [
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.driver_arrived,
];

/** Active riders who should receive co-passenger pickup updates. */
const ACTIVE_SPLIT_NOTIFY_STATUSES = [
  ...WAITING_PICKUP_STATUSES,
  PASSENGER_STATUS.picked_up,
];

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
    const io = getIO();

    // Client rule: upfront price is locked - waiting must NOT alter rider fare.
    const doPickup = async (passenger: any) => {
      const pickedUpAt = new Date();
      const lockedFare = passenger.estimatedFare || passenger.totalFare || 0;
      const { pickupDelaySeconds, waitThresholdExceeded } = computePickupDelay(
        passenger.arriveAt,
        pickedUpAt,
      );

      await Passenger.findByIdAndUpdate(passenger._id, {
        status: PASSENGER_STATUS.picked_up,
        pickedUpAt,
        waitingCharge: 0,
        waitingChargePaid: false,
        totalFare: lockedFare,
        pickupDelaySeconds,
        waitThresholdExceeded,
        waitFeeCharged: false,
      });

      const pickupPayload = {
        rideId,
        passengerId: passenger._id,
        driverId,
        pickedUpAt,
        waitingCharge: 0,
        totalFare: lockedFare,
        estimatedFare: lockedFare,
        message: 'You have been picked up!',
      };

      // Only the picked passenger gets this personal event
      io.to(`user:${passenger.userId}`).emit('ride:passenger-picked-up', pickupPayload);

      await notifyUserPush({
        userId: passenger.userId.toString(),
        message: 'You Have Been Picked Up!',
        description: 'Driver has picked you up. Safe journey!',
        reference: rideId,
        modelType: modeType.Ride,
        data: {
          type: 'PASSENGER_PICKED_UP',
          rideId: String(rideId),
          passengerId: String(passenger._id),
        },
      });

      await notifyUserPush({
        userId: driverId,
        message: 'Passenger Picked Up',
        description: 'Passenger has been successfully picked up.',
        reference: rideId,
        modelType: modeType.Ride,
        data: {
          type: 'PASSENGER_PICKED_UP',
          rideId: String(rideId),
          passengerId: String(passenger._id),
        },
      });

      await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
        event: 'PASSENGER_PICKED_UP',
        driverId,
        passengerId: passenger._id,
        timestamp: Date.now(),
      }));

      return { waitingCharge: 0 };
    };

    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
            _id: passengerId,
            rideId,
            status: { $in: [PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.in_progress] },
          })
        : await Passenger.findOne({
            rideId,
            status: { $in: [PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.in_progress] },
          });
      if (!passenger)
        return callback?.({ success: false, message: 'No passenger to pick up' });

      const { waitingCharge } = await doPickup(passenger);

      return callback?.({
        success: true,
        message: 'Passenger picked up successfully',
        data: { passengerId: passenger._id, waitingCharge },
      });
    }

    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: { $in: [PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.in_progress] },
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already picked up' });

      const { waitingCharge } = await doPickup(passenger);

      // Remaining = still waiting for pickup (not only driver_arrived)
      const remainingWaiting = await Passenger.find({
        rideId,
        status: { $in: WAITING_PICKUP_STATUSES },
      })
        .select('_id userId pickup destination status')
        .lean();

      const remainingCount = remainingWaiting.length;
      const allPickedUp = remainingCount === 0;

      const remainingPickups = remainingWaiting.map((p) => ({
        passengerId: p._id,
        pickup: p.pickup,
        destination: p.destination,
        status: p.status,
      }));

      // Driver always gets progress update
      io.to(`driver:${driverId}`).emit('ride:passenger-picked', {
        rideId,
        passengerId: passenger._id,
        remainingPassengers: remainingCount,
        allPickedUp,
        remainingPickups,
      });

      // Co-passengers (waiting + already onboard) get an update so map/route can refresh.
      // Do NOT send "all picked" until truly everyone is onboard.
      const coPassengers = await Passenger.find({
        rideId,
        _id: { $ne: passenger._id },
        status: { $in: ACTIVE_SPLIT_NOTIFY_STATUSES },
      })
        .select('_id userId status')
        .lean();

      const coPayload = {
        rideId,
        pickedPassengerId: passenger._id,
        remainingPassengers: remainingCount,
        allPickedUp,
        remainingPickups,
        message: allPickedUp
          ? 'All passengers have been picked up.'
          : 'A co-passenger has been picked up. Route may update.',
      };

      for (const co of coPassengers) {
        const userId = co.userId?.toString();
        if (!userId) continue;

        io.to(`user:${userId}`).emit('ride:co-passenger-picked-up', coPayload);

        // Already-onboard riders need this to refresh route when next rider boards
        if (co.status === PASSENGER_STATUS.picked_up) {
          await notifyUserPush({
            userId,
            message: 'Co-passenger Picked Up',
            description: coPayload.message,
            reference: rideId,
            modelType: modeType.Ride,
            data: {
              type: 'CO_PASSENGER_PICKED_UP',
              rideId: String(rideId),
              pickedPassengerId: String(passenger._id),
              allPickedUp: String(allPickedUp),
            },
          });
        }
      }

      // Ride room broadcast for clients already joined to ride:{id}
      io.to(`ride:${rideId}`).emit('ride:co-passenger-picked-up', coPayload);

      if (allPickedUp) {
        io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
          rideId,
          message: 'All passengers picked up. Ready to go!',
        });

        for (const co of coPassengers) {
          const userId = co.userId?.toString();
          if (!userId) continue;
          io.to(`user:${userId}`).emit('ride:all-passengers-picked', {
            rideId,
            message: 'All passengers picked up. Ready to go!',
          });
        }

        // Picked passenger also gets all-picked confirmation
        io.to(`user:${passenger.userId}`).emit('ride:all-passengers-picked', {
          rideId,
          message: 'All passengers picked up. Ready to go!',
        });
      }

      return callback?.({
        success: true,
        message: 'Passenger picked up successfully',
        data: {
          passengerId: passenger._id,
          waitingCharge,
          remainingPassengers: remainingCount,
          allPickedUp,
          remainingPickups,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);
