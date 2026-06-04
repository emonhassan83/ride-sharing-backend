import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { socketAuth } from './utils/socket.auth';
import onlineUsers from './utils/onlineUsers';
import { TSocket } from './interface/socket.interface';
import registerSocketEvents from './socket.event';
import { User } from '../modules/user/user.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { USER_ROLE } from '../modules/user/user.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { RIDE_STATUS } from '../modules/ride/ride.constant';

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

      // ── Driver room ───────────────────────────────────────────────────────
      if (userRole === USER_ROLE.provider) {
        tSocket.join(`driver:${userId}`);
        console.log(`✅ Driver joined room: driver:${userId}`);
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
                  PASSENGER_STATUS.searching,
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

      // ── Online status update ──────────────────────────────────────────────
      await User.findByIdAndUpdate(userId, {
        isOnline:     true,
        lastOnlineAt: new Date(),
      });

      console.log(`✅ User connected: ${userId}`);

      // ── Disconnect handler ────────────────────────────────────────────────
      socket.on('disconnect', async () => {
        delete onlineUsers[userId];
        await User.findByIdAndUpdate(userId, {
          isOnline:     false,
          lastOnlineAt: new Date(),
        });
        console.log(`❌ User disconnected: ${userId}`);
      });

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

export default initializeSocketIO;