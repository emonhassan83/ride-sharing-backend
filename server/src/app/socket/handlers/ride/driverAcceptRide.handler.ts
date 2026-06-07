// handlers/driver/driverAcceptRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { Booking } from '../../../modules/booking/booking.model';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import onlineUsers from '../../utils/onlineUsers';
import eventHandler from '../../utils/eventHandler';

// ── Helper: rider কে ride room এ join করাও ───────────────────────────────────
const ensureRiderInRoom = (userId: string, rideId: string) => {
  const riderSocket = onlineUsers[userId];
  if (riderSocket) {
    riderSocket.join(`ride:${rideId}`);
    console.log(`✅ Rider ${userId} joined room: ride:${rideId}`);
  } else {
    console.log(`⚠️ Rider ${userId} offline — cannot join room ride:${rideId}`);
  }
};

// ── Helper: driver current location from Redis ────────────────────────────────
const getDriverLocation = async (
  redis: any,
  driverId: string,
): Promise<{ lat: number; lng: number } | null> => {
  try {
    const raw = await redis.get(`driver:${driverId}:current`);
    if (!raw) return null;
    const { lat, lng } = JSON.parse(raw);
    return { lat, lng };
  } catch {
    return null;
  }
};

// ── Helper: calculate ETA from driver → pickup ────────────────────────────────
const calcEstimatedArrival = async (
  redis: any,
  driverId: string,
  pickupLat: number,
  pickupLng: number,
): Promise<number> => {
  const driverLoc = await getDriverLocation(redis, driverId);
  if (!driverLoc) return 5; // default 5 min if no location

  try {
    const { durationMinutes } = await getRealDistanceAndETA(
      { lat: driverLoc.lat, lng: driverLoc.lng },
      { lat: pickupLat,     lng: pickupLng     },
    );
    return durationMinutes;
  } catch {
    return 5;
  }
};

// ── Helper: build accepted payload ───────────────────────────────────────────
const buildAcceptedPayload = (
  rideId: string,
  passenger: any,
  booking: any,
  driverId: string,
  driverDetails: any,
  socket: TSocket,
  estimatedArrival: number,
  extra?: Record<string, any>,
) => ({
  rideId,
  passengerId:      passenger._id,
  bookingId:        booking._id,
  driverId,
  driverName:       driverDetails.name         || socket.auth?.name  || '',
  driverPhone:      driverDetails.phone        || socket.auth?.phone || '',
  driverPhoto:      driverDetails.photo        || socket.auth?.photo || '',
  carModel:         driverDetails.vehicleModel || 'Standard',
  carNumber:        driverDetails.vehicleNumber || '',
  estimatedArrival, // ✅ Google Maps calculated
  totalFare:        passenger.estimatedFare,
  status:           'confirmed',
  ...extra,
});

export const driverAcceptRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, acceptType = 'single' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io    = getIO();

    // ── Driver details from Redis ─────────────────────────────────────────────
    const driverDetails = await redis.hgetall(`driver:${driverId}:details`);
    if (!driverDetails || !Object.keys(driverDetails).length)
      return callback?.({ success: false, message: 'Driver data not found' });

    const totalSeats     = parseInt(driverDetails.seats)       || 4;
    const bookedSeats    = parseInt(driverDetails.bookedSeats) || 0;
    const availableSeats = totalSeats - bookedSeats;

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });

    // Driver joins ride room
    socket.join(`ride:${rideId}`);
    socket.join(`driver:${driverId}`);
    console.log(`✅ Driver ${driverId} joined room: ride:${rideId}`);

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'No pending passenger found' });

      if (availableSeats < (passenger.requestedSeats || 1))
        return callback?.({
          success: false,
          message: `Not enough seats. ${availableSeats} available, ${passenger.requestedSeats || 1} requested.`,
        });

      // ✅ Auto-calculate ETA from driver → passenger pickup
      const pickupLat      = passenger.pickup.coordinates[1];
      const pickupLng      = passenger.pickup.coordinates[0];
      const estimatedArrival = await calcEstimatedArrival(redis, driverId, pickupLat, pickupLng);

      await Ride.findByIdAndUpdate(rideId, {
        driverId,
        status: RIDE_STATUS.accepted,
      });

      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        passenger.requestedSeats || 1,
      );

      const booking = await Booking.create({
        passengerId:   passenger._id,
        rideId:        ride._id,
        userId:        passenger.userId,
        driverId,
        totalFare:     passenger.estimatedFare,
        amountPaid:    0,
        bookingStatus: BOOKING_STATUS.accepted,
        paymentStatus: PAYMENT_STATUS.pending,
      });

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      await redis.hset(`ride:active:${rideId}`, {
        driverId,
        status:         RIDE_STATUS.accepted,
        startedAt:      Date.now().toString(),
        passengerCount: '1',
      });
      await redis.expire(`ride:active:${rideId}`, 7200);

      ensureRiderInRoom(passenger.userId.toString(), rideId);

      const payload = buildAcceptedPayload(
        rideId, passenger, booking, driverId,
        driverDetails, socket, estimatedArrival,
        { rideFullyAccepted: true },
      );

      io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload);
      io.to(`ride:${rideId}`).emit('booking:payment-confirmed', payload);

      console.log(`✅ Private ride accepted | rideId: ${rideId} | eta: ${estimatedArrival}min`);

      return callback?.({
        success: true,
        message: 'Private ride accepted successfully',
        data:    { bookingId: booking._id, estimatedArrival },
      });
    }

    // ── SPLIT RIDE — accept ALL ───────────────────────────────────────────────
    if (acceptType === 'all') {
      const passengers = await Passenger.find({
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (!passengers.length)
        return callback?.({ success: false, message: 'No pending passengers' });

      const totalRequested = passengers.reduce((sum, p) => sum + (p.requestedSeats || 1), 0);
      if (availableSeats < totalRequested)
        return callback?.({
          success: false,
          message: `Not enough seats. ${availableSeats} available, ${totalRequested} requested.`,
        });

      await Ride.findByIdAndUpdate(rideId, {
        driverId,
        status: RIDE_STATUS.accepted,
      });

      await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', totalRequested);

      const bookings = [];

      for (const passenger of passengers) {
        // ✅ ETA per passenger pickup
        const pickupLat        = passenger.pickup.coordinates[1];
        const pickupLng        = passenger.pickup.coordinates[0];
        const estimatedArrival = await calcEstimatedArrival(redis, driverId, pickupLat, pickupLng);

        const booking = await Booking.create({
          passengerId:   passenger._id,
          rideId:        ride._id,
          userId:        passenger.userId,
          driverId,
          totalFare:     passenger.estimatedFare,
          amountPaid:    0,
          bookingStatus: BOOKING_STATUS.accepted,
          paymentStatus: PAYMENT_STATUS.pending,
        });
        bookings.push(booking);

        passenger.status = PASSENGER_STATUS.confirmed;
        await passenger.save();

        ensureRiderInRoom(passenger.userId.toString(), rideId);

        const payload = buildAcceptedPayload(
          rideId, passenger, booking, driverId,
          driverDetails, socket, estimatedArrival,
          { rideFullyAccepted: true },
        );

        io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload);
        io.to(`ride:${rideId}`).emit('booking:payment-confirmed', payload);
      }

      await redis.hset(`ride:active:${rideId}`, {
        driverId,
        status:         RIDE_STATUS.accepted,
        startedAt:      Date.now().toString(),
        passengerCount: passengers.length.toString(),
      });
      await redis.expire(`ride:active:${rideId}`, 7200);

      console.log(`✅ Split (all) accepted | rideId: ${rideId} | passengers: ${passengers.length}`);

      return callback?.({
        success: true,
        message: `Whole ride accepted. ${totalRequested} seat(s) booked.`,
        data:    { bookingsCount: bookings.length },
      });
    }

    // ── SPLIT RIDE — accept SINGLE ────────────────────────────────────────────
    if (acceptType === 'single' && passengerId) {
      const passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already processed' });

      const requestedSeats = passenger.requestedSeats || 1;
      if (availableSeats < requestedSeats)
        return callback?.({
          success: false,
          message: `Not enough seats. ${availableSeats} available, ${requestedSeats} requested.`,
        });

      // ✅ Auto ETA
      const pickupLat        = passenger.pickup.coordinates[1];
      const pickupLng        = passenger.pickup.coordinates[0];
      const estimatedArrival = await calcEstimatedArrival(redis, driverId, pickupLat, pickupLng);

      const otherCount        = await Passenger.countDocuments({
        rideId,
        _id:    { $ne: passenger._id },
        status: PASSENGER_STATUS.pending,
      });
      const hasOthers = otherCount > 0;

      await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', requestedSeats);

      const booking = await Booking.create({
        passengerId:   passenger._id,
        rideId:        ride._id,
        userId:        passenger.userId,
        driverId,
        totalFare:     passenger.estimatedFare,
        amountPaid:    0,
        bookingStatus: BOOKING_STATUS.accepted,
        paymentStatus: PAYMENT_STATUS.pending,
      });

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      if (!hasOthers) {
        await Ride.findByIdAndUpdate(rideId, { driverId, status: RIDE_STATUS.accepted });
        await redis.hset(`ride:active:${rideId}`, {
          driverId,
          status:         RIDE_STATUS.accepted,
          startedAt:      Date.now().toString(),
          passengerCount: '1',
        });
        await redis.expire(`ride:active:${rideId}`, 7200);
      } else {
        if (!ride.driverId) await Ride.findByIdAndUpdate(rideId, { driverId });
      }

      ensureRiderInRoom(passenger.userId.toString(), rideId);

      const payload = buildAcceptedPayload(
        rideId, passenger, booking, driverId,
        driverDetails, socket, estimatedArrival,
        {
          rideFullyAccepted:    !hasOthers,
          remainingPassengers:  hasOthers ? otherCount : 0,
        },
      );

      io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload);
      io.to(`ride:${rideId}`).emit('booking:payment-confirmed', payload);

      console.log(`✅ Split (single) accepted | rideId: ${rideId} | passengerId: ${passengerId} | eta: ${estimatedArrival}min`);

      return callback?.({
        success: true,
        message: hasOthers
          ? `Passenger accepted. ${otherCount} still searching.`
          : 'Passenger accepted. Ride fully booked.',
        data: {
          bookingId:         booking._id,
          estimatedArrival,
          rideFullyAccepted: !hasOthers,
        },
      });
    }

    return callback?.({
      success: false,
      message: 'Invalid acceptType or missing passengerId',
    });
  },
);