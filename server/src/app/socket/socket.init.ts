import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { socketAuth } from './utils/socket.auth';
import onlineUsers from './utils/onlineUsers';
import { TSocket } from './interface/socket.interface';
import registerSocketEvents from './socket.event';
import { User } from '../modules/user/user.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { RIDE_STATUS } from '../modules/ride/ride.constant';

let ioInstance: Server | null = null;

const initializeSocketIO = (server: HttpServer) => {
  ioInstance = new Server(server, {
    cors: { origin: '*', credentials: true },
  });

  // Middleware
  ioInstance.use(socketAuth);

  ioInstance.on('connection', async (socket: any) => {
    try {
      const userId = socket.auth?._id?.toString();
      if (!userId) {
        socket.disconnect();
        return;
      }

      // Update user online status
      await User.findByIdAndUpdate(
        userId,
        {
          isOnline: true,
          lastOnlineAt: new Date(),
        },
        { new: true }
      );

      const tSocket = socket as TSocket;
      tSocket.data = { user: socket.auth };

      tSocket.join(userId);
      onlineUsers[userId] = tSocket;

       // ✅ Reconnect হলে active ride room এ rejoin
  const [activePassenger, activeRide] = await Promise.all([
    Passenger.findOne({
      userId,
      // status: { $in: [PASSENGER_STATUS.searching, PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
    }).select('rideId').lean(),

    Ride.findOne({
      driverId: userId,
      // status: { $in: [RIDE_STATUS.accepted, RIDE_STATUS.driver_assigned, RIDE_STATUS.started] },
    }).select('_id').lean(),
  ])

  if (activePassenger?.rideId) {
    tSocket.join(`ride:${activePassenger.rideId}`)
    console.log(`✅ Rider rejoined room: ride:${activePassenger.rideId}`)
  }

  if (activeRide?._id) {
    tSocket.join(`ride:${activeRide._id}`)
    console.log(`✅ Driver rejoined room: ride:${activeRide._id}`)
  }

      console.log(`✅ User connected: ${userId}`);

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
