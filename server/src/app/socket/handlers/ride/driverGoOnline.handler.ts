// handlers/driver/driverGoOnline.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { User } from '../../../modules/user/user.model';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { saveDriverLocation } from '../../../utils/geo.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const driverGoOnlineHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const driverId = socket.auth?._id?.toString();
    const { lat, lng, destination, departureTime, vehicleId } = data;

    if (!driverId || !lat || !lng) {
      callback?.({ success: false, message: 'Location required' });
      return;
    }

    try {
      const redis = getRedisClient();
      const io = getIO();

      const existingPos = await redis.geopos('drivers:location', driverId);
      if (existingPos && existingPos[0] && existingPos[0][0] !== null) {
        return callback?.({ success: false, message: 'Driver is already online' });
      }

      const driver = await User.findById(driverId)
        .select('name phone avgRating profileImage')
        .lean();
      if (!driver) {
        return callback?.({ success: false, message: 'Driver not found' });
      }

      let vehicle = null;

      if (vehicleId) {
        vehicle = await Vehicle.findOne({
          _id: vehicleId,
          userId: driverId,
          isDeleted: false,
        });
        if (!vehicle) {
          return callback?.({
            success: false,
            message: 'Selected vehicle not found or not owned by you',
          });
        }
      } else {
        vehicle = await Vehicle.findOne({
          userId: driverId,
          isDefault: true,
          isDeleted: false,
        });
        if (!vehicle) {
          return callback?.({
            success: false,
            message:
              'No default vehicle set. Please set a default vehicle before going online.',
          });
        }
      }

      if (!vehicle.isDefault) {
        await Vehicle.updateOne({ _id: vehicle._id }, { isDefault: true });
        await Vehicle.updateMany(
          { userId: driverId, _id: { $ne: vehicle._id } },
          { isDefault: false }
        );
      }

      const driverHash: any = {
        name: driver.name || '',
        phone: driver.phone || '',
        rating: driver.avgRating?.toString() || '0',
        photo: driver.profileImage || '',
        vehicleModel: vehicle.name || '',
        vehicleNumber: vehicle.number || '',
        seats: vehicle.seats.toString(),
        bookedSeats: '0',
        status: 'online',
        lastLat: lat.toString(),
        lastLng: lng.toString(),
        lastUpdate: Date.now().toString(),
      };
      if (destination) driverHash.destination = JSON.stringify(destination);
      if (departureTime) driverHash.departureTime = departureTime;

      await redis.hset(`driver:${driverId}:details`, driverHash);
      await redis.expire(`driver:${driverId}:details`, 7200);
      await redis.set(
        `driver:${driverId}:current`,
        JSON.stringify({ lat, lng, timestamp: Date.now() })
      );
      await redis.expire(`driver:${driverId}:current`, 300);
      await saveDriverLocation(driverId, lat, lng);
      await redis.sadd('users:online', driverId);

      socket.join(`driver:${driverId}`);

      const onlineCount = await redis.scard('users:online');
      io.emit('onlineUser', onlineCount);

      callback?.({
        success: true,
        message: 'You are now online',
        data: { availableSeats: vehicle.seats, rating: driver.avgRating || 0 },
      });
    } catch (error) {
      console.error('Error in driverGoOnlineHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
