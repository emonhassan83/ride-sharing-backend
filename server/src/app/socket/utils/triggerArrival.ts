import { Types } from "mongoose";
import { PASSENGER_STATUS } from "../../modules/passenger/passenger.constant";
import { Passenger } from "../../modules/passenger/passenger.model";
import { RIDE_STATUS } from "../../modules/ride/ride.constant";
import { Ride } from "../../modules/ride/ride.model";

/**
 * অ্যারাইভ ইভেন্ট ট্রিগার করার হেল্পার ফাংশন
 */
export async function triggerArrival(
  rideId: string,
  passengerId: string | Types.ObjectId,
  driverId: string,
  lat: number,
  lng: number,
  io: any,
  redis: any
) {
  try {
    // কুলডাউন সেট করুন
    await redis.set(`ride:${rideId}:lastArrivalNotify`, Date.now().toString());
    await redis.expire(`ride:${rideId}:lastArrivalNotify`, 60);

    // প্যাসেঞ্জারের অ্যারাইভ টাইম সেট করুন
    const passenger = await Passenger.findById(passengerId);
    if (!passenger || passenger.arriveAt) return;

    passenger.arriveAt = new Date();
    await passenger.save();

    // লাইভ লোকেশন হিস্ট্রিতে ইভেন্ট যোগ করুন
    const locationKey = `ride:${rideId}:live`;
    await redis.rpush(locationKey, JSON.stringify({
      driverId,
      passengerId,
      event: 'ARRIVED_AT_PICKUP_GEOFENCE',
      lat,
      lng,
      timestamp: Date.now(),
    }));

    // প্যাসেঞ্জারকে নোটিফিকেশন পাঠান
    io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
      rideId,
      passengerId: passenger._id,
      driverId,
      message: 'Your driver has arrived at your pickup location',
      waitingTime: 2,
      autoDetected: true,
    //   distanceMeters: passenger.distanceToPickup, // optional
    });

    // চেক করুন সব প্যাসেঞ্জার অ্যারাইভ করেছে কিনা
    const remainingPassengers = await Passenger.countDocuments({
      rideId,
      status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
      arriveAt: { $exists: false }
    });

    if (remainingPassengers === 0) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.driver_arrived,
        arrivedAt: new Date(),
      });

      io.to(`ride:${rideId}`).emit('ride:all-passengers-arrived', {
        rideId,
        message: 'All passengers have been picked up',
      });
    }

    console.log(`✅ Auto-arrival (Geofence): ride=${rideId}, passenger=${passengerId}`);

  } catch (error) {
    console.error('Error in triggerArrival:', error);
  }
}