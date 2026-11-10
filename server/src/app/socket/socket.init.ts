import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { socketAuth } from './utils/socket.auth';
import onlineUsers from './utils/onlineUsers';
import { TSocket } from './interface/index.interface';
import registerSocketEvents from './socket.event';
import { User } from '../modules/user/user.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { USER_ROLE } from '../modules/user/user.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { getRedisClient } from '../config/redis.config';
import { Vehicle } from '../modules/vehicle/vehicle.model';

let ioInstance: Server | null = null;

const initializeSocketIO = (server: HttpServer) => {
  ioInstance = new Server(server, {
    cors: { origin: '*', credentials: true },
  });

  ioInstance.use(socketAuth);

  ioInstance.on('connection', async (socket: any) => {
    try {
      const userId   = socket.auth?._id?.toString();
      const userRole = socket.auth?.role;

      if (!userId) {
        socket.disconnect();
        return;
      }

      const tSocket = socket as TSocket;
      tSocket.data  = { user: socket.auth };

      // ── Base rooms — every user ───────────────────────────────────────────
      tSocket.join(userId);
      tSocket.join(`user:${userId}`);
      onlineUsers[userId] = tSocket;

      // ── Driver room & restore online state on reconnect ──────────────────
      const redis = getRedisClient();
      if (userRole === USER_ROLE.provider) {
        tSocket.join(`driver:${userId}`);
        console.log(`✅ Driver joined room: driver:${userId}`);

        const dbDriver = await User.findById(userId)
          .select('name profileImage phone avgRating isOnline location')
          .lean();

        if (dbDriver?.isOnline) {
          await redis.sadd('users:online', userId);
          await redis.del(`driver:${userId}:reconnecting`);

          const coords = dbDriver.location?.coordinates;
          if (
            coords &&
            Array.isArray(coords) &&
            coords.length === 2 &&
            (coords[0] !== 0 || coords[1] !== 0)
          ) {
            await redis.geoadd('drivers:location', coords[0], coords[1], userId);
          }

          const existingDetails = await redis.hgetall(`driver:${userId}:details`);
          if (!existingDetails || !existingDetails.driverId) {
            const vehicle = await Vehicle.findOne({
              userId,
              isDefault: true,
              isDeleted: false,
            }).lean();
            await redis.hset(`driver:${userId}:details`, {
              driverId: userId,
              name: dbDriver.name ?? '',
              photo: dbDriver.profileImage ?? '',
              phone: dbDriver.phone ?? '',
              rating: (dbDriver.avgRating ?? 5.0).toString(),
              vehicleId: vehicle?._id?.toString() ?? '',
              vehicleName: vehicle?.name ?? '',
              vehicleNumber: vehicle?.number ?? '',
              vehicleModel: vehicle?.name ?? '',
              totalSeats: (vehicle?.seats ?? 4).toString(),
              status: 'online',
              lastLat: (coords?.[1] ?? 0).toString(),
              lastLng: (coords?.[0] ?? 0).toString(),
              onlineAt: Date.now().toString(),
            });
          }
        }
      } else {
        await redis.sadd('users:online', userId);
      }

      // ── Rejoin active ride room ───────────────────────────────────────────
      const isDriver    = userRole === USER_ROLE.provider;
      const isRider     = !isDriver;

      const [activePassenger, activeRide] = await Promise.all([
        // Rider: find active passenger record
        isRider
          ? Passenger.findOne({
              userId,
              status: {
                $in: [
                  PASSENGER_STATUS.pending,
                  PASSENGER_STATUS.confirmed,
                  PASSENGER_STATUS.driver_arrived,
                  PASSENGER_STATUS.in_progress,
                  PASSENGER_STATUS.picked_up,
                ],
              },
            })
              .select('rideId')
              .lean()
          : null,

        // Driver: find active ride
        isDriver
          ? Ride.findOne({
              driverId: userId,
              status: {
                $in: [
                  RIDE_STATUS.pending,
                  RIDE_STATUS.accepted,
                  RIDE_STATUS.started,
                ],
              },
            })
              .select('_id')
              .lean()
          : null,
      ]);

      if (activePassenger?.rideId) {
        tSocket.join(`ride:${activePassenger.rideId}`);
        console.log(`✅ Rider rejoined room: ride:${activePassenger.rideId}`);
      }

      if (activeRide?._id) {
        tSocket.join(`ride:${activeRide._id}`);
        console.log(`✅ Driver rejoined room: ride:${activeRide._id}`);
      }

      registerSocketEvents(tSocket);
    } catch (err: any) {
      console.error('Connection error:', err.message);
      socket.disconnect();
    }
  });

  return ioInstance;
};

export const getIO = (): Server => {
  if (!ioInstance) throw new Error('Socket.IO not initialized');
  return ioInstance;
};

export { onlineUsers };

export default initializeSocketIO;