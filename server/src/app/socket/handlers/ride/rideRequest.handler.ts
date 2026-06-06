// handlers/ride/rideRequest.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { calculateDistance } from '../../../utils/location.utils';
import { calculateFareBreakdown } from '../../../utils/fareCalculator';
import { TSocket } from '../../interface/socket.interface';
import eventHandler from '../../utils/eventHandler';
import { getFareType } from '../../../utils/time.utils';
import { roundObjectNumbers, roundTo2 } from '../../../utils/number.utils';
import { getIO } from '../../socket.init';
import {
  getRealDistanceAndETA,
  getRouteGeometry,
  startMatchingForRide,
} from '../../../utils/maps.utils';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';

export const rideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      driverId,
      pickup,
      destination,
      type,
      seats,
      malePassengers,
      femalePassengers,
      scheduledDate,
      scheduledTime,
      luggageCounts,
      note,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId || !pickup || !destination) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }

    try {
      const requestedSeats = seats || 1;

      // ডিপার্চার ডেটটাইম তৈরি
      let departureDateTime = new Date();
      if (scheduledDate && scheduledTime) {
        const [year, month, day] = scheduledDate.split('-').map(Number);
        const [hour, minute] = scheduledTime.split(':').map(Number);
        departureDateTime = new Date(year, month - 1, day, hour, minute);
      }

      // প্রকৃত দূরত্ব ও ইটিএ (Google Maps API)
      let actualDistance = 0;
      let actualDuration = 0;
      try {
        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          { lat: pickup.lat, lng: pickup.lng },
          { lat: destination.lat, lng: destination.lng }
        );
        actualDistance = distanceKm;
        actualDuration = durationMinutes;
        console.log(
          `✅ Google Maps distance: ${actualDistance} km, duration: ${actualDuration} min`
        );
      } catch (err) {
        console.error(
          'Google Maps API failed, using straight-line distance',
          err
        );
        actualDistance = calculateDistance(
          { lat: pickup.lat, lng: pickup.lng },
          { lat: destination.lat, lng: destination.lng }
        );
        actualDuration = Math.ceil((actualDistance / 30) * 60);
      }

      // ✅ রুট জ্যামিতি সংগ্রহ (উভয় টাইপের জন্যই)
      let routeGeometry = {};
      try {
        routeGeometry = await getRouteGeometry(pickup, destination);
        console.log(`✅ Route geometry obtained for ${type} ride`);
      } catch (err) {
        console.error('Failed to get route geometry:', err);
        // রুট জ্যামিতি না পেলেও রাইড তৈরি চলবে, তবে পরবর্তীতে জয়েন করা কঠিন হবে
      }

      // ফেয়ার টাইপ নির্ধারণ (day / night)
      const fareType = getFareType(departureDateTime);

      // ফেয়ার ব্রেকডাউন ক্যালকুলেট (প্রকৃত দূরত্ব ব্যবহার করে)
      const fareBreakdown = await calculateFareBreakdown({
        distanceKm: actualDistance,
        departureDate: departureDateTime,
        departureTime: scheduledTime || new Date().toLocaleTimeString(),
        luggageCount: luggageCounts || 0,
        requestedSeats: requestedSeats,
        rideType: type,
        waitingMinutes: 0,
      });

      const roundedBreakdown = roundObjectNumbers(fareBreakdown);
      const estimatedDuration = actualDuration;

      // ── Get driver's default vehicle ──────────────────────────────────────────────
      let vehicleId = undefined;
      if (driverId) {
        const defaultVehicle = await Vehicle.findOne({
          userId: driverId,
          isDefault: true,
          isDeleted: false,
        })
          .select('_id')
          .lean();

        vehicleId = defaultVehicle?._id;
      }

      // Ride ডকুমেন্ট তৈরি
      const ride = await Ride.create({
        driverId,
        vehicleId,
        type,
        pickup: {
          address: pickup.address,
          coordinates: [pickup.lng, pickup.lat],
        },
        rideCreatedBy: userId,
        destination: {
          address: destination.address,
          coordinates: [destination.lng, destination.lat],
        },
        departureDate: scheduledDate || new Date().toISOString().split('T')[0],
        departureTime: scheduledTime || new Date().toLocaleTimeString(),
        totalSeats: requestedSeats,
        bookedSeats: 0,
        status: RIDE_STATUS.pending,
        routeGeometry,
      });

      // Passenger ডকুমেন্ট তৈরি
      const passenger = await Passenger.create({
        userId,
        rideId: ride._id,
        pickup: {
          address: pickup.address,
          coordinates: [pickup.lng, pickup.lat],
        },
        destination: {
          address: destination.address,
          coordinates: [destination.lng, destination.lat],
        },
        departureDate: scheduledDate || new Date().toISOString().split('T')[0],
        departureTime: scheduledTime || new Date().toLocaleTimeString(),
        requestedSeats: requestedSeats,
        fareType: fareType,
        initialCharge: fareBreakdown.initialCharge,
        perKmCharge: fareBreakdown.perKmCharge,
        totalKmCharge: roundTo2(fareBreakdown.totalKmCharge),
        luggageCharge: fareBreakdown.luggageCharge,
        holidayTripCharge: fareBreakdown.holidaySurcharge,
        vat: fareBreakdown.vat,
        estimatedFare: roundTo2(fareBreakdown.totalFare),
        waitingCharge: fareBreakdown.waitingCharge || 0,
        extraCharge: fareBreakdown.extraCharge || 0,
        estimatedDistanceKm: actualDistance,
        estimatedDurationMinutes: estimatedDuration,
        luggageCounts: luggageCounts || 0,
        note: note ?? '',
        status: PASSENGER_STATUS.searching,
        malePassengers: malePassengers || 0,
        femalePassengers: femalePassengers || 0,
      });

      const redis = getRedisClient();
      const io = getIO();

      // ============================================================
      // 🔹 রাইডার নির্দিষ্ট ড্রাইভার সিলেক্ট করলে (driverId থাকলে)
      // ============================================================
      if (driverId) {
        console.log(`🔍 Specific driver selected: ${driverId}`);

        // ১. ড্রাইভার অনলাইন কিনা চেক করুন
        const driverPos = await redis.geopos('drivers:location', driverId);
        console.log(`📍 Driver ${driverId} geopos:`, driverPos);
        if (!driverPos || !driverPos[0] || driverPos[0][0] === null) {
          console.log(`❌ Driver ${driverId} is not online (not in geoset)`);
          return callback?.({
            success: false,
            message: 'Selected driver is not available',
          });
        }
        console.log(
          `✅ Driver ${driverId} is online at (${driverPos[0][1]}, ${driverPos[0][0]})`
        );

        // 🔥 ২. রুমে কতজন সকেট আছে তা যাচাই করুন (ইমিটের আগে)
        const roomBefore = io.sockets.adapter.rooms.get(`driver:${driverId}`);
        console.log(
          `🛋️ Before emit, room driver:${driverId} has ${roomBefore?.size || 0} socket(s)`
        );

        if (!roomBefore || roomBefore.size === 0) {
          console.log(
            `⚠️ WARNING: No sockets in room driver:${driverId}. Driver may not have joined correctly.`
          );
        }

        // ৩. পেলোড তৈরি – ✅ এখানে নতুন ফিল্ড যোগ করা হয়েছে
        const payload = {
          rideId: ride._id.toString(),
          passengerId: passenger._id.toString(),
          pickup,
          destination,
          rideType: type, // 'private' or 'split'
          requestedSeats: requestedSeats, // কত সিট বুক করতে চায়
          luggageCount: luggageCounts || 0, // লাগেজ সংখ্যা
          estimatedFare: roundedBreakdown.totalFare,
          distance: actualDistance,
          riderRating: socket.auth?.avgRating || 5,
          expiresIn: 30,
        };
        console.log(
          `📡 Emitting ride:new-request to room driver:${driverId}`,
          payload
        );

        // ৪. রুমে সব সকেটে ইভেন্ট পাঠান
        io.to(`driver:${driverId}`).emit('ride:new-request', payload);
        console.log(`✅ ride:new-request emitted`);

        // 🔥 ৫. ইমিটের পরে রুমের সকেট সংখ্যা ও আইডি লিস্ট দেখুন
        const roomAfter = io.sockets.adapter.rooms.get(`driver:${driverId}`);
        console.log(
          `🛋️ After emit, room driver:${driverId} has ${roomAfter?.size || 0} socket(s)`
        );

        const socketsInRoom = await io.in(`driver:${driverId}`).fetchSockets();
        console.log(
          `📡 Socket IDs in room: ${socketsInRoom.map((s) => s.id).join(', ')}`
        );

        // ৬. টাইমআউট সেট করুন
        setTimeout(async () => {
          console.log(
            `⏰ Checking ride ${ride._id} status after 30 minutes...`
          );
          const stillPending = await Ride.findById(ride._id);
          if (stillPending && stillPending.status === RIDE_STATUS.pending) {
            console.log(
              `⏰ Timeout: Driver ${driverId} did not respond for ride ${ride._id}`
            );
            await Ride.findByIdAndUpdate(ride._id, {
              status: RIDE_STATUS.cancelled,
              cancellationReason: 'driver_timeout',
            });
            await Passenger.findByIdAndUpdate(passenger._id, {
              status: PASSENGER_STATUS.cancelled,
              cancellationReason: 'driver_timeout',
            });
            io.to(`user:${userId}`).emit('ride:driver-not-responded', {
              rideId: ride._id,
              message: 'Driver did not respond. Please try another driver.',
            });
            await redis.zrem('ride:matching:queue', ride._id.toString());
            await redis.del(`ride:request:${ride._id}`);
            console.log(`❌ Ride ${ride._id} cancelled due to driver timeout`);
          } else if (
            stillPending &&
            stillPending.status !== RIDE_STATUS.pending
          ) {
            console.log(
              `✅ Ride ${ride._id} was accepted or completed before timeout.`
            );
          }
        }, 30 * 60000);

        // রেডিসে রাইড ডাটা রাখুন
        await redis.zadd(
          'ride:matching:queue',
          Date.now(),
          ride._id.toString()
        );
        await redis.hset(`ride:request:${ride._id}`, {
          userId,
          passengerId: passenger._id.toString(),
          pickup: JSON.stringify(pickup),
          destination: JSON.stringify(destination),
          seats: requestedSeats.toString(),
          estimatedFare: fareBreakdown.totalFare.toString(),
          timestamp: Date.now(),
        });
        await redis.expire(`ride:request:${ride._id}`, 300);

        socket.join(`ride:${ride._id}`);
        socket.join(`passenger:${passenger._id}`);

        callback?.({
          success: true,
          message: 'Ride request sent to selected driver.',
          data: {
            rideId: ride._id,
            passengerId: passenger._id,
            estimatedFare: roundedBreakdown.totalFare,
            estimatedDistance: roundTo2(actualDistance),
            estimatedDuration,
            fareBreakdown: roundedBreakdown,
          },
        });
        return;
      }

      // ============================================================
      // 🔸 স্বয়ংক্রিয় ম্যাচিং (driverId না থাকলে আগের নিয়ম)
      // ============================================================
      await redis.zadd('ride:matching:queue', Date.now(), ride._id.toString());
      await redis.hset(`ride:request:${ride._id}`, {
        userId,
        passengerId: passenger._id.toString(),
        pickup: JSON.stringify(pickup),
        destination: JSON.stringify(destination),
        seats: requestedSeats.toString(),
        estimatedFare: fareBreakdown.totalFare.toString(),
        timestamp: Date.now(),
      });
      await redis.expire(`ride:request:${ride._id}`, 300);

      socket.join(`ride:${ride._id}`);
      socket.join(`passenger:${passenger._id}`);

      startMatchingForRide(ride._id.toString()).catch((err) =>
        console.error('Matching error:', err)
      );

      callback?.({
        success: true,
        message: 'Ride requested successfully. Finding a driver...',
        data: {
          rideId: ride._id,
          passengerId: passenger._id,
          estimatedFare: roundedBreakdown.totalFare,
          estimatedDistance: roundTo2(actualDistance),
          estimatedDuration,
          fareBreakdown: roundedBreakdown,
        },
      });
    } catch (error) {
      console.error('Error in rideRequestHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
