// handlers/driver/driverArrived.handler.ts
import { getRedisClient } from "../../../config/redis.config";
import { PASSENGER_STATUS } from "../../../modules/passenger/passenger.constant";
import { Ride } from "../../../modules/ride/ride.model";
import { Passenger } from "../../../modules/passenger/passenger.model";
import { TSocket } from "../../interface/socket.interface";
import { getIO } from "../../socket.init";
import eventHandler from "../../utils/eventHandler";
import { RIDE_STATUS, RIDE_TYPE } from "../../../modules/ride/ride.constant";

/**
 * driver:arrived-pickup Handler
 * 
 * কেস ১: প্রাইভেট রাইড – শুধু rideId দিলে পুরো রাইডের জন্য অ্যারাইভড নোটিফিকেশন
 * কেস ২: স্প্লিট রাইড – নির্দিষ্ট passengerId দিলে শুধু সেই প্যাসেঞ্জারকে নোটিফিকেশন
 * কেস ৩: স্প্লিট রাইড – সব প্যাসেঞ্জারের জন্য (rideId + arriveAll = true) – ঐচ্ছিক
 */
export const driverArrivedHandler = eventHandler<any>(
  async (socket: TSocket, data: any) => {
    let { rideId, passengerId, arriveAll = false, lat, lng } = data;
    const driverId = socket.auth?._id?.toString();

    if (!rideId) {
      console.error('Missing rideId');
      return;
    }

    try {
      const ride = await Ride.findById(rideId);
      if (!ride) return;

      const io = getIO();
      const redis = getRedisClient();

      // === কেস ১: প্রাইভেট রাইড ===
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({ rideId, status: PASSENGER_STATUS.matched });
        if (!passenger) return;

        // রাইডের status আপডেট
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.driver_arrived,
          arrivedAt: new Date(),
        });

        // প্যাসেঞ্জারের arriveAt ও arrivedNotified আপডেট
        passenger.arriveAt = new Date();
        passenger.arrivedNotified = true;
        await passenger.save();

        // রেডিস ইভেন্ট লগ
        await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
          driverId,
          event: 'ARRIVED_AT_PICKUP',
          passengerId: passenger._id,
          lat,
          lng,
          timestamp: Date.now(),
        }));

        // প্যাসেঞ্জারকে নোটিফিকেশন
        io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
          rideId,
          passengerId: passenger._id,
          driverId,
          message: 'Driver has arrived at your pickup location',
          waitingTime: 2,
        });

        // ওয়েটিং চার্জ টাইমার
        setTimeout(async () => {
          const currentRide = await Ride.findById(rideId);
          if (currentRide && currentRide.status === RIDE_STATUS.driver_arrived) {
            io.to(`user:${passenger.userId}`).emit('ride:waiting-charge', {
              rideId,
              passengerId: passenger._id,
              message: 'Waiting charges will apply after 2 minutes',
            });
          }
        }, 180000);
        return;
      }

      // === কেস ২: স্প্লিট রাইড – নির্দিষ্ট প্যাসেঞ্জার ===
      if (passengerId && !arriveAll) {
        const passenger = await Passenger.findOne({ _id: passengerId, rideId, status: PASSENGER_STATUS.matched });
        if (!passenger) return;

        // প্যাসেঞ্জারের arriveAt ও arrivedNotified আপডেট
        passenger.arriveAt = new Date();
        passenger.arrivedNotified = true;
        await passenger.save();

        // চেক করুন এই রাইডের সব প্যাসেঞ্জার ইতিমধ্যে arrived নোটিফিকেশন পেয়েছে কিনা
        const allPassengers = await Passenger.find({ rideId, status: PASSENGER_STATUS.matched });
        const allNotified = allPassengers.every(p => p.arrivedNotified === true);

        if (allNotified) {
          // সব প্যাসেঞ্জার নোটিফাইড হলে রাইডের status driver_arrived করুন
          await Ride.findByIdAndUpdate(rideId, {
            status: RIDE_STATUS.driver_arrived,
            arrivedAt: new Date(),
          });
        }

        // রেডিস ইভেন্ট লগ
        await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
          driverId,
          event: 'ARRIVED_AT_PICKUP',
          passengerId: passenger._id,
          lat,
          lng,
          timestamp: Date.now(),
        }));

        // শুধু এই প্যাসেঞ্জারকে নোটিফিকেশন
        io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
          rideId,
          passengerId: passenger._id,
          driverId,
          message: 'Driver has arrived at your pickup location',
          waitingTime: 2,
          isLastArrival: allNotified, // জানান যে এটি শেষ অ্যারাইভাল কিনা
        });

        // ওয়েটিং চার্জ টাইমার (শুধু এই প্যাসেঞ্জারের জন্য)
        setTimeout(async () => {
          const currentPassenger = await Passenger.findById(passenger._id);
          if (currentPassenger && currentPassenger.arriveAt && !currentPassenger.pickedUpAt) {
            io.to(`user:${passenger.userId}`).emit('ride:waiting-charge', {
              rideId,
              passengerId: passenger._id,
              message: 'Waiting charges will apply after 2 minutes',
            });
          }
        }, 180000);
        return;
      }

      // === কেস ৩: স্প্লিট রাইড – সব প্যাসেঞ্জারের জন্য একসাথে অ্যারাইভ (ঐচ্ছিক) ===
      if (arriveAll) {
        const passengers = await Passenger.find({ rideId, status: PASSENGER_STATUS.matched });
        if (passengers.length === 0) return;

        // সব প্যাসেঞ্জারের arriveAt ও arrivedNotified আপডেট
        for (const passenger of passengers) {
          passenger.arriveAt = new Date();
          passenger.arrivedNotified = true;
          await passenger.save();

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
            message: 'Driver has arrived at your pickup location',
            waitingTime: 2,
          });
        }

        // রাইডের status driver_arrived করুন
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.driver_arrived,
          arrivedAt: new Date(),
        });
      }

    } catch (error) {
      console.error('Error in driverArrivedHandler:', error);
    }
  }
);