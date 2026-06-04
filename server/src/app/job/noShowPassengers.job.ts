// jobs/noShowHandler.job.ts (Background job)
import { getRedisClient } from "../config/redis.config";
import { BOOKING_STATUS } from "../modules/booking/booking.constant";
import { Booking } from "../modules/booking/booking.model";
import { PASSENGER_STATUS } from "../modules/passenger/passenger.constant";
import { Passenger } from "../modules/passenger/passenger.model";
import { RIDE_STATUS } from "../modules/ride/ride.constant";
import { Ride } from "../modules/ride/ride.model";
import { getIO } from "../socket/socket.init";


const NO_SHOW_WAIT_TIME = 60 * 60 * 1000; // 1 hour in milliseconds
const BATCH_SIZE = 50;

/**
 * Check for no-show passengers (driver arrived but passenger didn't)
 * Run this job every 30 seconds
 */
export const checkNoShowPassengers = async () => {
  try {
    const redis = getRedisClient();
    const io = getIO();
    const cutoff = new Date(Date.now() - NO_SHOW_WAIT_TIME);

    // ✅ সীমিত সংখ্যক রাইড একবারে প্রসেস
    const rides = await Ride.find({
      status: RIDE_STATUS.started,
      arrivedAt: { $lt: cutoff },
    })
      .select('_id driverId')
      .limit(BATCH_SIZE)
      .lean();

    if (rides.length === 0) return;

    const rideIds = rides.map(r => r._id);

    // ✅ প্যাসেঞ্জার বাল্ক আপডেট
    const updateResult = await Passenger.updateMany(
      {
        rideId: { $in: rideIds },
        status: { $in: [PASSENGER_STATUS.confirmed] },
        arrivedNotified: true,
        pickedUpAt: null,
      },
      {
        status: PASSENGER_STATUS.cancelled,
        cancellationReason: 'no_show',
        cancelledBy: 'system',
      }
    );

    if (updateResult.modifiedCount === 0) return;

    // ✅ আপডেট হওয়া প্যাসেঞ্জারদের তথ্য নিয়ে বুকিং ও নোটিফিকেশন
    const passengers = await Passenger.find({
      rideId: { $in: rideIds },
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'no_show',
    }).select('_id userId rideId requestedSeats').lean();

    const passengerIds = passengers.map(p => p._id);
    const bookingUpdate = await Booking.updateMany(
      { passengerId: { $in: passengerIds } },
      {
        bookingStatus: BOOKING_STATUS.cancelled,
        cancellationReason: 'no_show',
        refundAmount: 50,
      }
    );

    // ✅ রাইডের বুকড সিট কমানো (প্রতি রাইডের জন্য আলাদাভাবে)
    const seatUpdates: Record<string, number> = {};
    for (const p of passengers) {
      const rid = p.rideId.toString();
      seatUpdates[rid] = (seatUpdates[rid] || 0) + (p.requestedSeats || 1);
    }
    for (const [rideId, seats] of Object.entries(seatUpdates)) {
      await Ride.updateOne({ _id: rideId }, { $inc: { bookedSeats: -seats } });
    }

    // ✅ নোটিফিকেশন পাঠানো (প্রতি প্যাসেঞ্জার ও ড্রাইভার)
    const rideMap = new Map(rides.map(r => [r._id.toString(), r.driverId.toString()]));
    for (const p of passengers) {
      const driverId = rideMap.get(p.rideId.toString());
      io.to(`user:${p.userId}`).emit('ride:no-show-charge', {
        rideId: p.rideId,
        passengerId: p._id,
        charge: 50,
        message: "You didn't show up at pickup location. A no-show fee has been charged.",
      });
      if (driverId) {
        io.to(`driver:${driverId}`).emit('ride:passenger-no-show', {
          rideId: p.rideId,
          passengerId: p._id,
          compensation: 50,
          message: "Passenger didn't show up. You will receive compensation.",
        });
      }
    }

    // ✅ রাইডে কোনো প্যাসেঞ্জার অবশিষ্ট না থাকলে পুরো রাইড ক্যানসেল
    const remainingPassengers = await Passenger.aggregate([
      { $match: { rideId: { $in: rideIds }, status: { $ne: PASSENGER_STATUS.cancelled } } },
      { $group: { _id: '$rideId', count: { $sum: 1 } } },
    ]);
    const noPassengerRideIds = rideIds.filter(rid => !remainingPassengers.find(r => r._id.toString() === rid.toString()));
    if (noPassengerRideIds.length) {
      await Ride.updateMany(
        { _id: { $in: noPassengerRideIds }, status: RIDE_STATUS.started },
        { status: RIDE_STATUS.cancelled, cancellationReason: 'all_passengers_no_show' }
      );
      const multi = redis.multi();
      for (const rid of noPassengerRideIds) {
        multi.del(`ride:active:${rid}`);
      }
      await multi.exec();
    }

    console.log(`✅ No-show processed: ${updateResult.modifiedCount} passengers`);
  } catch (error) {
    console.error('Error in checkNoShowPassengers:', error);
  }
};