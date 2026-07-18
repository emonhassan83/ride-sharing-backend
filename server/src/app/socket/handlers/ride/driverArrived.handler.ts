// handlers/driver/driverArrived.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { User } from '../../../modules/user/user.model';
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import {
  getWaitingRatePerMinute,
  isNightFare,
} from '../../../utils/waitingCharge.utils';
import { haversineMeters } from '../../../utils/geo.utils';

const ARRIVAL_THRESHOLD_METERS = 100;

const checkDriverNearPickup = async (
  redis: any,
  driverId: string,
  pickupLat: number,
  pickupLng: number,
  manualLat?: number,
  manualLng?: number
): Promise<{ isNear: boolean; distanceMeters: number }> => {
  let driverLat: number | null = null;
  let driverLng: number | null = null;

  if (manualLat != null && manualLng != null) {
    driverLat = manualLat;
    driverLng = manualLng;
  }

  if (driverLat === null) {
    try {
      const raw = await redis.get(`driver:${driverId}:current`);
      if (raw) {
        const current = JSON.parse(raw);
        driverLat = current.lat;
        driverLng = current.lng;
      }
    } catch {
      /* ignore */
    }
  }

  if (driverLat === null) {
    try {
      const hash = await redis.hgetall(`driver:${driverId}:details`);
      if (hash?.lastLat && hash?.lastLng) {
        driverLat = parseFloat(hash.lastLat);
        driverLng = parseFloat(hash.lastLng);
      }
    } catch {
      /* ignore */
    }
  }

  if (driverLat === null || driverLng === null)
    return { isNear: false, distanceMeters: -1 };

  const distanceMeters = haversineMeters(
    driverLat,
    driverLng,
    pickupLat,
    pickupLng
  );

  return {
    isNear: distanceMeters <= ARRIVAL_THRESHOLD_METERS,
    distanceMeters: Math.round(distanceMeters),
  };
};

export const driverArrivedHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, arriveAll = false, lat, lng } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId)
      return callback?.({ success: false, message: 'Unauthorized' });
    if (!rideId)
      return callback?.({ success: false, message: 'Missing rideId' });

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({
        success: false,
        message: 'You are not assigned to this ride',
      });

    const validStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
    if (!validStatuses.includes(ride.status as any))
      return callback?.({
        success: false,
        message: `Cannot trigger arrived — status: ${ride.status}`,
      });

    const io = getIO();
    const redis = getRedisClient();

    const night = isNightFare(ride.departureTime ?? '08:00');
    const waitingRatePerMinute = await getWaitingRatePerMinute(night);

    // ── Helper: notify passenger ──────────────────────────────────────────────
    const notifyPassenger = async (passenger: any, isLastArrival = false) => {
      await Passenger.findByIdAndUpdate(passenger._id, {
        arriveAt: new Date(),
        arrivedNotified: true,
        status: PASSENGER_STATUS.driver_arrived,
      });

      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          driverId,
          event: 'ARRIVED_AT_PICKUP',
          passengerId: passenger._id,
          lat,
          lng,
          timestamp: Date.now(),
        })
      );

      // Socket
      io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
        rideId,
        passengerId: passenger._id,
        driverId,
        message: 'Driver has arrived at your pickup location',
        isLastArrival,
      });

      // ✅ FCM push — driver arrived
      const riderUser = await User.findById(passenger.userId)
        .select('fcmToken')
        .lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Driver Has Arrived!',
          description:
            'Your driver is at your pickup location. Please be ready within minutes.',
          reference: rideId,
          modelType: modeType.Ride,
        }).catch(() => {});
      }

      // ── 2 min grace → waiting charge ─────────────────────────────────────
      setTimeout(
        async () => {
          const p = await Passenger.findById(passenger._id);
          if (!p || p.pickedUpAt) return;

          const waitingStartedAt = new Date();
          await Passenger.findByIdAndUpdate(passenger._id, {
            waitingStartedAt,
          });

          // Socket
          io.to(`user:${passenger.userId}`).emit(
            'ride:waiting-charge-started',
            {
              rideId,
              passengerId: passenger._id,
              ratePerMinute: waitingRatePerMinute,
              ratePerHour: Math.round(waitingRatePerMinute * 60 * 100) / 100,
              startedAt: waitingStartedAt,
              message: `Waiting charge started: £${waitingRatePerMinute.toFixed(4)}/min`,
            }
          );

          io.to(`driver:${driverId}`).emit('ride:waiting-charge-active', {
            rideId,
            passengerId: passenger._id,
            message: 'Waiting charge is now active for this passenger.',
          });

          // ✅ FCM push — waiting charge started
          if (riderUser?.fcmToken) {
            sendNotification([riderUser.fcmToken], {
              receiver: passenger.userId,
              message: 'Waiting Charge Started!',
              description: `Driver is waiting. Charge: £${waitingRatePerMinute.toFixed(4)}/min. Please arrive ASAP.`,
              reference: rideId,
              modelType: modeType.Ride,
            }).catch(() => {});
          }
        },
        2 * 60 * 1000
      );
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId ? await Passenger.findOne({
         _id: passengerId,
        rideId,
        status: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
      }) : await Passenger.findOne({
        rideId,
        status: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'No active passenger found',
        });

      console.log({ passenger });

      const { isNear, distanceMeters } = await checkDriverNearPickup(
        redis,
        driverId,
        passenger.pickup.coordinates[1],
        passenger.pickup.coordinates[0],
        lat,
        lng
      );

      if (!isNear)
        return callback?.({
          success: false,
          message: `You are not at the pickup location yet. You are ${distanceMeters}m away. Please be within ${ARRIVAL_THRESHOLD_METERS}m to mark arrival.`,
          distanceMeters,
          thresholdMeters: ARRIVAL_THRESHOLD_METERS,
        });

      await notifyPassenger(passenger, true);

      return callback?.({
        success: true,
        message: 'Driver arrived notification sent',
        data: { passengerId: passenger._id, distanceMeters },
      });
    }

    // ── SPLIT — specific passenger ────────────────────────────────────────────
    if (passengerId && !arriveAll) {
      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ]
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'Passenger not found or already notified',
        });

      const { isNear, distanceMeters } = await checkDriverNearPickup(
        redis,
        driverId,
        passenger.pickup.coordinates[1],
        passenger.pickup.coordinates[0],
        lat,
        lng
      );

      if (!isNear)
        return callback?.({
          success: false,
          message: `You are not at passenger's pickup. You are ${distanceMeters}m away. Please be within ${ARRIVAL_THRESHOLD_METERS}m.`,
          distanceMeters,
          thresholdMeters: ARRIVAL_THRESHOLD_METERS,
        });

      await notifyPassenger(passenger);

      const remaining = await Passenger.countDocuments({
        rideId,
        status: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
        arrivedNotified: false,
      });

      return callback?.({
        success: true,
        message: 'Driver arrived notification sent',
        data: {
          passengerId: passenger._id,
          remainingUnnotified: remaining,
          distanceMeters,
        },
      });
    }

    // ── SPLIT — all passengers ────────────────────────────────────────────────
    if (arriveAll) {
      const passengers = await Passenger.find({
        rideId,
        status: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
        arrivedNotified: false,
      });
      if (!passengers.length)
        return callback?.({
          success: false,
          message: 'No unnotified passengers',
        });

      const results: any[] = [];

      for (let i = 0; i < passengers.length; i++) {
        const passenger = passengers[i];
        const { isNear, distanceMeters } = await checkDriverNearPickup(
          redis,
          driverId,
          passenger.pickup.coordinates[1],
          passenger.pickup.coordinates[0],
          lat,
          lng
        );

        if (!isNear) {
          results.push({
            passengerId: passenger._id,
            notified: false,
            distanceMeters,
            message: `Not near pickup (${distanceMeters}m away)`,
          });
          continue;
        }

        await notifyPassenger(passenger, i === passengers.length - 1);
        results.push({
          passengerId: passenger._id,
          notified: true,
          distanceMeters,
        });
      }

      const notifiedCount = results.filter((r) => r.notified).length;
      const skippedCount = results.filter((r) => !r.notified).length;

      return callback?.({
        success: true,
        message:
          notifiedCount > 0
            ? `Arrived notification sent to ${notifiedCount} passenger(s).${skippedCount > 0 ? ` ${skippedCount} skipped.` : ''}`
            : 'No passengers notified — not near any pickup.',
        data: { results, notifiedCount, skippedCount },
      });
    }

    return callback?.({
      success: false,
      message: 'Provide passengerId or arriveAll=true',
    });
  }
);
