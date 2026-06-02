// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from "../../../config/redis.config";
import { RIDE_STATUS, RIDE_TYPE } from "../../../modules/ride/ride.constant";
import { PASSENGER_STATUS } from "../../../modules/passenger/passenger.constant";
import { BOOKING_STATUS, PAYMENT_STATUS } from "../../../modules/booking/booking.constant";
import { Ride } from "../../../modules/ride/ride.model";
import { Passenger } from "../../../modules/passenger/passenger.model";
import { Booking } from "../../../modules/booking/booking.model";
import { RiderHistory } from "../../../modules/riderHistory/riderHistory.model";
import { calculateTotalDistance, calculateDuration, calculateFareFromDistance } from "../../../utils/location.utils";
import { saveLocationsToDatabase } from "../../../utils/location.db.utils";
import { TSocket } from "../../interface/socket.interface";
import { getIO } from "../../socket.init";
import eventHandler from "../../utils/eventHandler";
import { RIDE_HISTORY_PAYMENT_STATUS, RIDE_HISTORY_STATUS } from "../../../modules/riderHistory/riderHistory.constant";

/**
 * driver:complete-trip Handler
 * 
 * কেস ১: স্প্লিট রাইড – নির্দিষ্ট প্যাসেঞ্জার ড্রপ (passengerId + completeType='single')
 * কেস ২: স্প্লিট রাইড – সব প্যাসেঞ্জার একসাথে ড্রপ (completeType='all')
 * কেস ৩: প্রাইভেট রাইড – সম্পূর্ণ রাইড ড্রপ (completeType যেকোনো কিছু হতে পারে)
 */
export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    let {
      rideId,
      passengerId,
      fare,
      distance,
      duration,
      endOdometer,
      completeType = 'all',
      waitingCharge = 0,
      extraCharge = 0,
    } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }

    try {
      const redis = getRedisClient();
      const ride = await Ride.findById(rideId);

      if (!ride) {
        return callback?.({ success: false, message: 'Ride not found' });
      }
      if (ride.driverId?.toString() !== driverId) {
        return callback?.({ success: false, message: 'You are not assigned to this ride' });
      }
      if (ride.status !== RIDE_STATUS.in_progress) {
        return callback?.({ success: false, message: `Ride cannot be completed in current state: ${ride.status}` });
      }

      const io = getIO();

      // ড্রাইভার তথ্য (Redis থেকে)
      const driverDetails = await redis.hgetall(`driver:${driverId}:details`);
      const driverName = driverDetails?.name || socket.auth?.name || 'Unknown';
      const driverPhone = driverDetails?.phone || socket.auth?.phone || '';
      const driverPhoto = driverDetails?.photo || socket.auth?.photo || '';
      const carModel = driverDetails?.vehicleModel || 'Standard';
      const carNumber = driverDetails?.vehicleNumber || '';

      // লোকেশন হিস্ট্রি
      const locationKey = `ride:${rideId}:live`;
      const locations = await redis.lrange(locationKey, 0, -1);
      const parsedLocations = locations.map((loc) => JSON.parse(loc));

      let actualDistance = distance;
      let actualFare = fare;
      if (!actualDistance && parsedLocations.length > 0) {
        actualDistance = calculateTotalDistance(parsedLocations);
        actualFare = calculateFareFromDistance(actualDistance);
      }

      // ========== প্রাইভেট রাইড ==========
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({
          rideId,
          status: PASSENGER_STATUS.picked_up, // শুধু picked_up
        });
        if (!passenger) {
          return callback?.({ success: false, message: 'No passenger found for this private ride' });
        }

        const individualFare = actualFare + waitingCharge + extraCharge;

        // বুকিং আপডেট
        await Booking.findOneAndUpdate(
          { passengerId: passenger._id },
          {
            totalFare: individualFare,
            bookingStatus: BOOKING_STATUS.completed,
            paymentStatus: PAYMENT_STATUS.pending,
          }
        );

        // প্যাসেঞ্জার আপডেট
        passenger.status = PASSENGER_STATUS.dropped_off;
        passenger.droppedOffAt = new Date();
        if (waitingCharge) passenger.waitingCharge = waitingCharge;
        if (extraCharge) passenger.extraCharge = extraCharge;
        await passenger.save();

        // রাইড আপডেট
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.completed,
          completedAt: new Date(),
          endOdometer: endOdometer || 0,
          actualDistance,
          actualFare: individualFare,
          tripDuration: duration || calculateDuration(parsedLocations),
        });

        // RiderHistory তৈরি
        await RiderHistory.create({
          userId: passenger.userId,
          rideId: ride._id,
          summary: {
            pickupAddress: passenger.pickup.address,
            pickupCoordinates: passenger.pickup.coordinates,
            destinationAddress: passenger.destination.address,
            destinationCoordinates: passenger.destination.coordinates,
            date: new Date(),
            fare: individualFare,
            distance: actualDistance,
            duration: duration || calculateDuration(parsedLocations),
            rideType: ride.type,
          },
          driver: {
            driverId: ride.driverId,
            driverName,
            driverPhone,
            driverPhoto,
            carModel,
            carNumber,
          },
          paymentStatus: RIDE_HISTORY_PAYMENT_STATUS.pending,
          status: RIDE_HISTORY_STATUS.completed,
        });

        // নোটিফিকেশন
        io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
          rideId,
          passengerId: passenger._id,
          fare: individualFare,
          distance: actualDistance,
          duration: duration || calculateDuration(parsedLocations),
          message: 'Trip completed successfully',
          waitingCharge,
          extraCharge,
        });

        io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });

        // লোকেশন হিস্ট্রি সেভ ও রেডিস ক্লিনআপ
        await saveLocationsToDatabase(rideId, parsedLocations, driverId);
        await redis.del(locationKey);
        await redis.del(`ride:active:${rideId}`);
        await redis.del(`driver:${driverId}:activeRide`);

        return callback?.({
          success: true,
          message: 'Private ride completed successfully',
          fare: individualFare,
          passengerCount: 1,
          allDroppedOff: true,
        });
      }

      // ========== স্প্লিট রাইড ==========

      // কেস ১: নির্দিষ্ট প্যাসেঞ্জার ড্রপ অফ (single)
      if (completeType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: PASSENGER_STATUS.picked_up,
        });
        if (!passenger) {
          return callback?.({ success: false, message: 'Passenger not found or already dropped off' });
        }

        const individualFare = (passenger.estimatedFare || actualFare) + waitingCharge + extraCharge;

        // বুকিং আপডেট
        await Booking.findOneAndUpdate(
          { passengerId: passenger._id },
          {
            totalFare: individualFare,
            bookingStatus: BOOKING_STATUS.completed,
            paymentStatus: PAYMENT_STATUS.pending,
          }
        );

        // প্যাসেঞ্জার আপডেট
        passenger.status = PASSENGER_STATUS.dropped_off;
        passenger.droppedOffAt = new Date();
        if (waitingCharge) passenger.waitingCharge = waitingCharge;
        if (extraCharge) passenger.extraCharge = extraCharge;
        await passenger.save();

        // RiderHistory তৈরি
        await RiderHistory.create({
          userId: passenger.userId,
          rideId: ride._id,
          summary: {
            pickupAddress: passenger.pickup.address,
            pickupCoordinates: passenger.pickup.coordinates,
            destinationAddress: passenger.destination.address,
            destinationCoordinates: passenger.destination.coordinates,
            date: new Date(),
            fare: individualFare,
            distance: actualDistance,
            duration: duration || calculateDuration(parsedLocations),
            rideType: ride.type,
          },
          driver: {
            driverId: ride.driverId,
            driverName,
            driverPhone,
            driverPhoto,
            carModel,
            carNumber,
          },
          paymentStatus: RIDE_HISTORY_PAYMENT_STATUS.pending,
          status: RIDE_HISTORY_STATUS.completed,
        });

        // ইভেন্ট লগ
        await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
          event: 'PASSENGER_DROPPED_OFF',
          driverId,
          passengerId: passenger._id,
          timestamp: Date.now(),
          endOdometer: endOdometer || 0,
        }));

        // ✅ প্রথম ড্রপ অফে endOdometer রাইড ডকুমেন্টে সেভ (যদি পাঠানো থাকে)
        if (endOdometer && !ride.endOdometer) {
          await Ride.findByIdAndUpdate(rideId, { endOdometer });
        }

        // নোটিফিকেশন
        io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
          rideId,
          passengerId: passenger._id,
          fare: individualFare,
          distance: actualDistance,
          duration: duration || calculateDuration(parsedLocations),
          message: 'You have been dropped off. Thank you for riding with us!',
          waitingCharge,
          extraCharge,
        });
        io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });

        // বাকি প্যাসেঞ্জার সংখ্যা
        const remainingPassengers = await Passenger.countDocuments({
          rideId,
          status: PASSENGER_STATUS.picked_up,
        });
        const allDroppedOff = remainingPassengers === 0;

        // সব প্যাসেঞ্জার ড্রপ হলে রাইড সম্পন্ন
        if (allDroppedOff) {
          await Ride.findByIdAndUpdate(rideId, {
            status: RIDE_STATUS.completed,
            completedAt: new Date(),
            actualDistance,
            tripDuration: duration || calculateDuration(parsedLocations),
          });

          // লোকেশন হিস্ট্রি একবারই সেভ
          await saveLocationsToDatabase(rideId, parsedLocations, driverId);

          // রেডিস ক্লিনআপ
          await redis.del(locationKey);
          await redis.del(`ride:active:${rideId}`);
          await redis.del(`driver:${driverId}:activeRide`);

          io.to(`driver:${driverId}`).emit('ride:all-passengers-dropped', {
            rideId,
            message: 'All passengers have been dropped off. Ride completed.',
          });
        }

        return callback?.({
          success: true,
          message: allDroppedOff
            ? 'All passengers dropped off. Ride completed successfully!'
            : `Passenger dropped off. ${remainingPassengers} passenger(s) remaining.`,
          passengerId: passenger._id,
          fare: individualFare,
          remainingPassengers,
          allDroppedOff,
        });
      }

      // কেস ২: সব প্যাসেঞ্জার একসাথে ড্রপ (completeType === 'all')
      if (completeType === 'all') {
        const passengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.picked_up,
        });
        if (passengers.length === 0) {
          return callback?.({ success: false, message: 'No passengers found for this ride' });
        }

        for (const passenger of passengers) {
          const individualFare = (passenger.estimatedFare || actualFare) + waitingCharge + extraCharge;

          // বুকিং আপডেট
          await Booking.findOneAndUpdate(
            { passengerId: passenger._id },
            {
              totalFare: individualFare,
              bookingStatus: BOOKING_STATUS.completed,
              paymentStatus: PAYMENT_STATUS.pending,
            }
          );

          // প্যাসেঞ্জার আপডেট
          passenger.status = PASSENGER_STATUS.dropped_off;
          passenger.droppedOffAt = new Date();
          if (waitingCharge) passenger.waitingCharge = waitingCharge;
          if (extraCharge) passenger.extraCharge = extraCharge;
          await passenger.save();

          // RiderHistory তৈরি
          await RiderHistory.create({
            userId: passenger.userId,
            rideId: ride._id,
            summary: {
              pickupAddress: passenger.pickup.address,
              pickupCoordinates: passenger.pickup.coordinates,
              destinationAddress: passenger.destination.address,
              destinationCoordinates: passenger.destination.coordinates,
              date: new Date(),
              fare: individualFare,
              distance: actualDistance,
              duration: duration || calculateDuration(parsedLocations),
              rideType: ride.type,
            },
            driver: {
              driverId: ride.driverId,
              driverName,
              driverPhone,
              driverPhoto,
              carModel,
              carNumber,
            },
            paymentStatus: RIDE_HISTORY_PAYMENT_STATUS.pending,
            status: RIDE_HISTORY_STATUS.completed,
          });

          // নোটিফিকেশন
          io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
            rideId,
            passengerId: passenger._id,
            fare: individualFare,
            distance: actualDistance,
            duration: duration || calculateDuration(parsedLocations),
            message: 'Trip completed successfully. Thank you for riding with us!',
            waitingCharge,
            extraCharge,
          });
          io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });
        }

        // রাইড আপডেট
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.completed,
          completedAt: new Date(),
          endOdometer: endOdometer || 0,
          actualDistance,
          tripDuration: duration || calculateDuration(parsedLocations),
        });

        // লোকেশন হিস্ট্রি সেভ
        await saveLocationsToDatabase(rideId, parsedLocations, driverId);

        // রেডিস ক্লিনআপ
        await redis.del(locationKey);
        await redis.del(`ride:active:${rideId}`);
        await redis.del(`driver:${driverId}:activeRide`);

        const totalEarnings = passengers.reduce((sum, p) => sum + (p.estimatedFare || 0), 0) + waitingCharge + extraCharge;
        const platformCommission = totalEarnings * 0.15;
        const driverEarnings = totalEarnings - platformCommission;

        return callback?.({
          success: true,
          message: 'All passengers dropped off. Ride completed successfully!',
          fare: actualFare,
          totalEarnings,
          driverEarnings,
          platformCommission,
          passengerCount: passengers.length,
          allDroppedOff: true,
        });
      }

      return callback?.({ success: false, message: 'Invalid completeType or missing passengerId for single dropoff' });
    } catch (error) {
      console.error('Error in driverCompleteTripHandler:', error);
      return callback?.({ success: false, message: 'Internal server error' });
    }
  }
);