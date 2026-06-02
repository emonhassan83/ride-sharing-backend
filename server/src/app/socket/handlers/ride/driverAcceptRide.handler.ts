// handlers/driver/driverAcceptRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  BOOKING_STATUS,
  PAYMENT_STATUS,
} from '../../../modules/booking/booking.constant';
import { Booking } from '../../../modules/booking/booking.model';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const driverAcceptRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    let { rideId, passengerId, estimatedArrival = 5, acceptType = 'single' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }

    try {
      const redis = getRedisClient();

      // ড্রাইভারের বিস্তারিত ও বর্তমান বুকড সিট Redis থেকে পড়ি
      let driverDetails = await redis.hgetall(`driver:${driverId}:details`);
      if (!driverDetails || Object.keys(driverDetails).length === 0) {
        return callback?.({ success: false, message: 'Driver data not found' });
      }

      const totalSeats = parseInt(driverDetails.seats) || 4;
      const bookedSeats = parseInt(driverDetails.bookedSeats) || 0;
      const availableSeats = totalSeats - bookedSeats;

      const ride = await Ride.findById(rideId);
      if (!ride) {
        return callback?.({ success: false, message: 'Ride not found' });
      }

      const io = getIO();

      // ===============================
      // কেস ১: প্রাইভেট রাইড
      // ===============================
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({
          rideId,
          status: PASSENGER_STATUS.searching,
        });
        if (!passenger) {
          return callback?.({ success: false, message: 'No pending passenger found' });
        }

        if (availableSeats < (passenger.requestedSeats || 1)) {
          return callback?.({
            success: false,
            message: `Not enough seats. Only ${availableSeats} seat(s) available, but requested ${passenger.requestedSeats || 1}.`,
          });
        }

        await Ride.findByIdAndUpdate(rideId, {
          driverId,
          status: RIDE_STATUS.accepted,
        });

        await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', passenger.requestedSeats || 1);

        const booking = await Booking.create({
          passengerId: passenger._id,
          rideId: ride._id,
          userId: passenger.userId,
          driverId,
          totalFare: passenger.estimatedFare,
          amountPaid: 0,
          bookingStatus: BOOKING_STATUS.accepted,
          paymentStatus: PAYMENT_STATUS.pending,
        });

        passenger.status = PASSENGER_STATUS.matched;
        await passenger.save();

        await redis.hset(`ride:active:${rideId}`, {
          driverId,
          status: RIDE_STATUS.accepted,
          startedAt: Date.now(),
          passengerCount: '1',
        });
        await redis.expire(`ride:active:${rideId}`, 7200);

        // ✅ প্যাসেঞ্জারকে বুকিং নিশ্চিতকরণ ইভেন্ট
        io.to(`user:${passenger.userId}`).emit('booking:payment-confirmed', {
          rideId,
          passengerId: passenger._id,
          bookingId: booking._id,
          driverId,
          driverName: driverDetails.name || socket.auth?.name,
          carModel: driverDetails.vehicleModel || 'Standard',
          carNumber: driverDetails.vehicleNumber || '',
          estimatedArrival,
          totalFare: passenger.estimatedFare,
          status: 'confirmed',
        });

        // পূর্বের `ride:driver-accepted` ইভেন্টও রাখা হলো (ঐচ্ছিক)
        io.to(`user:${passenger.userId}`).emit('ride:driver-accepted', {
          rideId,
          passengerId: passenger._id,
          bookingId: booking._id,
          driverId,
          driverName: driverDetails.name || socket.auth?.name,
          driverPhone: driverDetails.phone || socket.auth?.phone,
          driverPhoto: driverDetails.photo || socket.auth?.photo,
          carModel: driverDetails.vehicleModel || 'Standard',
          carNumber: driverDetails.vehicleNumber || '',
          estimatedArrival,
          rideFullyAccepted: true,
        });

        socket.join(`ride:${rideId}`);
        socket.join(`driver:${driverId}`);

        return callback?.({
          success: true,
          message: 'Private ride accepted successfully',
          bookingId: booking._id,
        });
      }

      // ===============================
      // কেস ২: স্প্লিট রাইড – পুরো রাইড একসেপ্ট (সব প্যাসেঞ্জার)
      // ===============================
      if (acceptType === 'all') {
        const passengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.searching,
        });
        if (!passengers.length) {
          return callback?.({ success: false, message: 'No pending passengers for this ride' });
        }

        const totalRequestedSeats = passengers.reduce((sum, p) => sum + (p.requestedSeats || 1), 0);
        if (availableSeats < totalRequestedSeats) {
          return callback?.({
            success: false,
            message: `Not enough seats. Only ${availableSeats} seat(s) available, but requested ${totalRequestedSeats}.`,
          });
        }

        await Ride.findByIdAndUpdate(rideId, {
          driverId,
          status: RIDE_STATUS.accepted,
        });

        await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', totalRequestedSeats);

        const bookings = [];

        for (const passenger of passengers) {
          const booking = await Booking.create({
            passengerId: passenger._id,
            rideId: ride._id,
            userId: passenger.userId,
            driverId,
            totalFare: passenger.estimatedFare,
            amountPaid: 0,
            bookingStatus: BOOKING_STATUS.accepted,
            paymentStatus: PAYMENT_STATUS.pending,
          });
          bookings.push(booking);

          passenger.status = PASSENGER_STATUS.matched;
          await passenger.save();

          // ✅ প্রতিটি প্যাসেঞ্জারকে বুকিং নিশ্চিতকরণ ইভেন্ট
          io.to(`user:${passenger.userId}`).emit('booking:payment-confirmed', {
            rideId,
            passengerId: passenger._id,
            bookingId: booking._id,
            driverId,
            driverName: driverDetails.name || socket.auth?.name,
            carModel: driverDetails.vehicleModel || 'Standard',
            carNumber: driverDetails.vehicleNumber || '',
            estimatedArrival,
            totalFare: passenger.estimatedFare,
            status: 'confirmed',
          });

          // পূর্বের ride:driver-accepted ইভেন্ট (ঐচ্ছিক)
          io.to(`user:${passenger.userId}`).emit('ride:driver-accepted', {
            rideId,
            passengerId: passenger._id,
            bookingId: booking._id,
            driverId,
            driverName: driverDetails.name || socket.auth?.name,
            driverPhone: driverDetails.phone || socket.auth?.phone,
            driverPhoto: driverDetails.photo || socket.auth?.photo,
            carModel: driverDetails.vehicleModel || 'Standard',
            carNumber: driverDetails.vehicleNumber || '',
            estimatedArrival,
            rideFullyAccepted: true,
          });
        }

        await redis.hset(`ride:active:${rideId}`, {
          driverId,
          status: RIDE_STATUS.accepted,
          startedAt: Date.now(),
          passengerCount: passengers.length.toString(),
        });
        await redis.expire(`ride:active:${rideId}`, 7200);

        socket.join(`ride:${rideId}`);
        socket.join(`driver:${driverId}`);

        return callback?.({
          success: true,
          message: `Whole ride accepted. ${totalRequestedSeats} seat(s) booked.`,
          bookingsCount: bookings.length,
        });
      }

      // ===============================
      // কেস ৩: স্প্লিট রাইড – নির্দিষ্ট একটি প্যাসেঞ্জার একসেপ্ট
      // ===============================
      if (acceptType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: PASSENGER_STATUS.searching,
        });
        if (!passenger) {
          return callback?.({ success: false, message: 'Passenger not found or already processed' });
        }

        const requestedSeats = passenger.requestedSeats || 1;
        if (availableSeats < requestedSeats) {
          return callback?.({
            success: false,
            message: `Not enough seats. Only ${availableSeats} seat(s) available, but requested ${requestedSeats}.`,
          });
        }

        const otherPassengers = await Passenger.countDocuments({
          rideId,
          _id: { $ne: passenger._id },
          status: PASSENGER_STATUS.searching,
        });
        const hasOtherPassengers = otherPassengers > 0;

        await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', requestedSeats);

        const booking = await Booking.create({
          passengerId: passenger._id,
          rideId: ride._id,
          userId: passenger.userId,
          driverId,
          totalFare: passenger.estimatedFare,
          amountPaid: 0,
          bookingStatus: BOOKING_STATUS.accepted,
          paymentStatus: PAYMENT_STATUS.pending,
        });

        passenger.status = PASSENGER_STATUS.matched;
        await passenger.save();

        if (!hasOtherPassengers) {
          await Ride.findByIdAndUpdate(rideId, {
            driverId,
            status: RIDE_STATUS.accepted,
          });
          await redis.hset(`ride:active:${rideId}`, {
            driverId,
            status: RIDE_STATUS.accepted,
            startedAt: Date.now(),
            passengerCount: '1',
          });
          await redis.expire(`ride:active:${rideId}`, 7200);
        } else {
          if (!ride.driverId) {
            await Ride.findByIdAndUpdate(rideId, { driverId });
          }
        }

        // ✅ নির্দিষ্ট প্যাসেঞ্জারকে বুকিং নিশ্চিতকরণ ইভেন্ট
        io.to(`user:${passenger.userId}`).emit('booking:payment-confirmed', {
          rideId,
          passengerId: passenger._id,
          bookingId: booking._id,
          driverId,
          driverName: driverDetails.name || socket.auth?.name,
          carModel: driverDetails.vehicleModel || 'Standard',
          carNumber: driverDetails.vehicleNumber || '',
          estimatedArrival,
          totalFare: passenger.estimatedFare,
          status: 'confirmed',
        });

        // পূর্বের ride:driver-accepted ইভেন্ট (ঐচ্ছিক)
        io.to(`user:${passenger.userId}`).emit('ride:driver-accepted', {
          rideId,
          passengerId: passenger._id,
          bookingId: booking._id,
          driverId,
          driverName: driverDetails.name || socket.auth?.name,
          driverPhone: driverDetails.phone || socket.auth?.phone,
          driverPhoto: driverDetails.photo || socket.auth?.photo,
          carModel: driverDetails.vehicleModel || 'Standard',
          carNumber: driverDetails.vehicleNumber || '',
          estimatedArrival,
          rideFullyAccepted: !hasOtherPassengers,
          remainingPassengers: hasOtherPassengers ? otherPassengers : 0,
        });

        socket.join(`ride:${rideId}`);
        socket.join(`driver:${driverId}`);

        return callback?.({
          success: true,
          message: hasOtherPassengers
            ? `Passenger ${passengerId} accepted. Other passengers are still searching.`
            : `Passenger accepted. Ride fully booked.`,
          bookingId: booking._id,
          rideFullyAccepted: !hasOtherPassengers,
        });
      }

      callback?.({
        success: false,
        message: 'Invalid accept type or missing passengerId for single acceptance',
      });
    } catch (error) {
      console.error('Error in driverAcceptRideHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);