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
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import onlineUsers from '../../utils/onlineUsers';
import eventHandler from '../../utils/eventHandler';
import { recalculateSplitFares } from '../../../utils/splitFare.utils';
import { ILatLng } from '../../interface/ride';
import { User } from '../../../modules/user/user.model';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';

// ── Helper: rider কে ride room এ join করাও ───────────────────────────────────
const ensureRiderInRoom = (userId: string, rideId: string) => {
  const riderSocket = onlineUsers[userId];
  if (riderSocket) {
    riderSocket.join(`ride:${rideId}`);
  }
};

// ── Helper: driver current location from Redis ────────────────────────────────
const getDriverLocation = async (
  redis: any,
  driverId: string
): Promise<ILatLng | null> => {
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
  pickupLng: number
): Promise<number> => {
  const driverLoc = await getDriverLocation(redis, driverId);
  if (!driverLoc) return 5;
  try {
    const { durationMinutes } = await getRealDistanceAndETA(
      { lat: driverLoc.lat, lng: driverLoc.lng },
      { lat: pickupLat, lng: pickupLng }
    );
    return durationMinutes;
  } catch {
    return 5;
  }
};

// ── Helper: build accepted payload ────────────────────────────────────────────
const buildAcceptedPayload = (
  rideId: string,
  passenger: any,
  booking: any,
  driverId: string,
  driverDetails: any,
  socket: TSocket,
  estimatedArrival: number,
  extra?: Record<string, any>
) => ({
  rideId,
  passengerId: passenger._id,
  bookingId: booking._id,
  driverId,
  driverName: driverDetails.name || socket.auth?.name || '',
  driverPhone: driverDetails.phone || socket.auth?.phone || '',
  driverPhoto: driverDetails.photo || socket.auth?.photo || '',
  carModel: driverDetails.vehicleModel || 'Standard',
  carNumber: driverDetails.vehicleNumber || '',
  estimatedArrival,
  totalFare: passenger.estimatedFare,
  status: 'confirmed',
  ...extra,
});

// ── Helper: cancel rider's other pending split ride requests ──────────────────
const cancelOtherPendingRequests = async (
  userId: string,
  acceptedRideId: string,
  io: any
) => {
  const otherPending = await Passenger.find({
    userId,
    rideId: { $ne: acceptedRideId },
    status: PASSENGER_STATUS.pending,
  }).lean();

  if (!otherPending.length) return;

  for (const other of otherPending) {
    await Passenger.findByIdAndUpdate(other._id, {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'accepted_another_ride',
    });

    const otherRide = await Ride.findById(other.rideId)
      .select('driverId')
      .lean();

    if (otherRide?.driverId) {
      io.to(`driver:${otherRide.driverId}`).emit('ride:passenger-withdrew', {
        rideId: other.rideId.toString(),
        passengerId: other._id.toString(),
        message: 'Passenger accepted another ride.',
      });
    }

    io.to(`ride:${other.rideId}`).emit('ride:passenger-withdrew', {
      rideId: other.rideId.toString(),
      passengerId: other._id.toString(),
      message: 'Passenger accepted another ride.',
    });
  }
};

export const driverAcceptRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    // ── Driver details from Redis ─────────────────────────────────────────────
    const driverDetails = await redis.hgetall(`driver:${driverId}:details`);
    if (!driverDetails || !Object.keys(driverDetails).length)
      return callback?.({
        success: false,
        message: 'Driver data not found. Please go online first.',
      });

    const totalSeats = parseInt(driverDetails.seats) || 4;
    const bookedSeats = parseInt(driverDetails.bookedSeats) || 0;
    const availableSeats = totalSeats - bookedSeats;

    // ── Driver's default vehicle ──────────────────────────────────────────────
    const defaultVehicle = await Vehicle.findOne({
      userId: driverId,
      isDefault: true,
      isDeleted: false,
    })
      .select('_id')
      .lean();

    const vehicleId = defaultVehicle?._id ?? null;

    // ── Ride ──────────────────────────────────────────────────────────────────
    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });

    // ── Race condition guard ──────────────────────────────────────────────────
    if (
      ride.status !== RIDE_STATUS.pending &&
      ride.status !== RIDE_STATUS.accepted
    )
      return callback?.({
        success: false,
        message: 'This ride has already been accepted or cancelled.',
      });

    socket.join(`ride:${rideId}`);
    socket.join(`driver:${driverId}`);

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'No pending passenger found',
        });

      if (availableSeats < (passenger.requestedSeats || 1))
        return callback?.({
          success: false,
          message: `Not enough seats. ${availableSeats} available, ${passenger.requestedSeats || 1} requested.`,
        });

      const pickupLat = passenger.pickup.coordinates[1];
      const pickupLng = passenger.pickup.coordinates[0];
      const estimatedArrival = await calcEstimatedArrival(
        redis,
        driverId,
        pickupLat,
        pickupLng
      );

      // ✅ driverId + vehicleId save, bookedSeats NOT here (happens in confirmPayment)
      await Ride.findByIdAndUpdate(rideId, {
        driverId,
        vehicleId,
        status: RIDE_STATUS.accepted,
      });

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

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      // ✅ Notify rider — driver accepted
      const riderUser = await User.findById(passenger.userId)
        .select('fcmToken')
        .lean();

      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Driver Accepted Your Ride!',
          description: `Your driver accept in your ride. Check it your app.`,
          reference: passenger.id,
          modelType: modeType.Passenger,
        });
      }

      await cancelOtherPendingRequests(passenger.userId.toString(), rideId, io);

      // Notify other online drivers — ride taken
      const onlineNearby = (await redis.georadius(
        'drivers:location',
        ride.pickup.coordinates[0],
        ride.pickup.coordinates[1],
        10,
        'km'
      )) as string[];

      for (const otherDriverId of onlineNearby) {
        if (otherDriverId === driverId) continue;
        io.to(`driver:${otherDriverId}`).emit('ride:already-taken', {
          rideId,
          message: 'This ride has been accepted by another driver.',
        });
      }

      await redis.hset(`ride:active:${rideId}`, {
        driverId,
        status: RIDE_STATUS.accepted,
        startedAt: Date.now().toString(),
        passengerCount: '1',
      });
      await redis.expire(`ride:active:${rideId}`, 7200);
      await redis.set(`driver:${driverId}:activeRide`, rideId, 'EX', 7200);

      ensureRiderInRoom(passenger.userId.toString(), rideId);

      const payload = buildAcceptedPayload(
        rideId,
        passenger,
        booking,
        driverId,
        driverDetails,
        socket,
        estimatedArrival,
        { rideFullyAccepted: true }
      );

      io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload);
      console.log(
        `✅ Private accepted | rideId: ${rideId} | eta: ${estimatedArrival}min`
      );

      return callback?.({
        success: true,
        message: 'Private ride accepted successfully',
        data: { bookingId: booking._id, estimatedArrival },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({
          success: false,
          message: 'passengerId is required for split ride',
        });

      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'Passenger not found or already processed',
        });

      const requestedSeats = passenger.requestedSeats || 1;
      if (availableSeats < requestedSeats)
        return callback?.({
          success: false,
          message: `Not enough seats. ${availableSeats} available, ${requestedSeats} requested.`,
        });

      const pickupLat = passenger.pickup.coordinates[1];
      const pickupLng = passenger.pickup.coordinates[0];
      const estimatedArrival = await calcEstimatedArrival(
        redis,
        driverId,
        pickupLat,
        pickupLng
      );

      const remainingCount = await Passenger.countDocuments({
        rideId,
        _id: { $ne: passenger._id },
        status: PASSENGER_STATUS.pending,
      });
      const isLastPassenger = remainingCount === 0;

      // ✅ driverId + vehicleId save (first accept only), bookedSeats NOT here
      const rideUpdate: Record<string, any> = {};
      if (!ride.driverId) {
        rideUpdate.driverId = driverId;
        rideUpdate.vehicleId = vehicleId; // ✅
      }
      if (isLastPassenger) rideUpdate.status = RIDE_STATUS.accepted;

      if (Object.keys(rideUpdate).length) {
        await Ride.findByIdAndUpdate(rideId, rideUpdate);
      }

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

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      // ✅ Notify rider — driver accepted
      const riderUser = await User.findById(passenger.userId)
        .select('fcmToken')
        .lean();

      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Driver Accepted Your Ride!',
          description: `Your driver accept in your ride. Check it your app.`,
          reference: passenger.id,
          modelType: modeType.Passenger,
        });
      }

      await cancelOtherPendingRequests(passenger.userId.toString(), rideId, io);

      // Recalculate split fares (Cases 30, 31)
      recalculateSplitFares(rideId, 'passenger_joined', io).catch((err) =>
        console.error('Recalculate error after accept:', err)
      );

      if (isLastPassenger) {
        await redis.hset(`ride:active:${rideId}`, {
          driverId,
          status: RIDE_STATUS.accepted,
          startedAt: Date.now().toString(),
          passengerCount: '1',
        });
        await redis.expire(`ride:active:${rideId}`, 7200);
        await redis.set(`driver:${driverId}:activeRide`, rideId, 'EX', 7200);
      }

      ensureRiderInRoom(passenger.userId.toString(), rideId);

      const payload = buildAcceptedPayload(
        rideId,
        passenger,
        booking,
        driverId,
        driverDetails,
        socket,
        estimatedArrival,
        {
          rideFullyAccepted: isLastPassenger,
          remainingPassengers: remainingCount,
        }
      );

      io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload);
      console.log(
        `✅ Split accepted | passengerId: ${passengerId} | remaining: ${remainingCount} | eta: ${estimatedArrival}min`
      );

      return callback?.({
        success: true,
        message: isLastPassenger
          ? 'Passenger accepted. All passengers confirmed.'
          : `Passenger accepted. ${remainingCount} still pending.`,
        data: {
          bookingId: booking._id,
          estimatedArrival,
          rideFullyAccepted: isLastPassenger,
          remainingPassengers: remainingCount,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  }
);
