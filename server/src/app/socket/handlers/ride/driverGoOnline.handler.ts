// handlers/driver/driverGoOnline.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { User } from '../../../modules/user/user.model';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { saveDriverLocation } from '../../../utils/geo.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const driverGoOnlineHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const driverId = socket.auth?._id?.toString();
    const { lat, lng, vehicleId } = data;

    if (!driverId || !lat || !lng) {
      return callback?.({ success: false, message: 'Location (lat, lng) is required' });
    }

    try {
      const redis = getRedisClient();
      const io = getIO();

      // ── 1. Get Driver Info ─────────────────────────────────────────────
      const driver = await User.findById(driverId)
        .select('name email phone avgRating profileImage isOnline')
        .lean();

      if (!driver) {
        return callback?.({ success: false, message: 'Driver not found' });
      }

      // ── 2. Validate Vehicle ───────────────────────────────────────────
      let vehicle = null;
      if (vehicleId) {
        vehicle = await Vehicle.findOne({
          _id: vehicleId,
          userId: driverId,
          isDeleted: false,
        });
        if (!vehicle) {
          return callback?.({ success: false, message: 'Selected vehicle not found or not owned by you' });
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
            message: 'No default vehicle set. Please set a default vehicle before going online.'
          });
        }
      }

      // ── 3. Set Default Vehicle if needed ─────────────────────────────
      if (!vehicle.isDefault) {
        await Vehicle.updateOne({ _id: vehicle._id }, { isDefault: true });
        await Vehicle.updateMany(
          { userId: driverId, _id: { $ne: vehicle._id } },
          { isDefault: false }
        );
      }

      // ── 4. Update User Model — Enable isOnline Flag ───────────────────
      await User.findByIdAndUpdate(driverId, {
        isOnline: true,
        lastOnlineAt: new Date(),
        location: {
          type: 'Point',
          coordinates: [lng, lat],
        },
      });

      // ── 5. Save Driver Details in Redis ───────────────────────────────
      const driverHash: any = {
        name: driver.name || '',
        email: driver.email || '',
        phone: driver.phone || '',
        rating: (driver.avgRating || 0).toString(),
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

      await redis.hset(`driver:${driverId}:details`, driverHash);
      await redis.expire(`driver:${driverId}:details`, 86400); // 24 hours

      await redis.set(
        `driver:${driverId}:current`,
        JSON.stringify({ lat, lng, timestamp: Date.now() }),
        'EX',
        300 // 5 minutes
      );

      await saveDriverLocation(driverId, lat, lng);
      await redis.sadd('users:online', driverId);
      socket.join(`driver:${driverId}`);

      // ── 6. Broadcast Online Count ─────────────────────────────────────
      const onlineCount = await redis.scard('users:online');
      io.emit('onlineUser', onlineCount);

      callback?.({
        success: true,
        message: 'You are now online and available for rides',
        data: {
          availableSeats: vehicle.seats,
          rating: driver.avgRating || 0,
          isOnline: true,
        },
      });
    } catch (error: any) {
      console.error('Error in driverGoOnlineHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);