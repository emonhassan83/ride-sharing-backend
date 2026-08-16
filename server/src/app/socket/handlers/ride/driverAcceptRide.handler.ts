// handlers/driver/driverAcceptRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  BOOKING_STATUS,
  PAYMENT_STATUS,
} from '../../../modules/booking/booking.constant';
import { Booking } from '../../../modules/booking/booking.model';
import { Chat } from '../../../modules/chat/chat.models';
import { CHAT_STATUS } from '../../../modules/chat/chat.constants';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { User } from '../../../modules/user/user.model';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import onlineUsers from '../../utils/onlineUsers';
import eventHandler from '../../utils/eventHandler';
import { ILatLng } from '../../interface/ride';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';
import { PaymentService } from '../../../modules/payment/payment.service';
import { recalculateSplitFares } from '../../../utils/splitFare.utils';

const ensureRiderInRoom = (userId: string, rideId: string) => {
  const riderSocket = onlineUsers[userId];
  if (riderSocket) riderSocket.join(`ride:${rideId}`);
};

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


const notifyAdminForNewPendingBooking = async (booking: any) => {
  try {
    const admin = await User.findOne({ role: 'admin', isDeleted: false })
      .select('_id fcmToken')
      .lean();

    if (!admin?.fcmToken) return;

    await sendNotification([admin.fcmToken], {
      receiver: admin._id,
      message: 'New Pending Order',
      description: 'A new order/booking is waiting for review.',
      reference: booking._id.toString(),
      modelType: modeType.Booking,
    });
  } catch (error) {
    console.error('Admin pending booking notification failed:', error);
  }
};
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

// â”€â”€ Helper: get driver available seats for a specific ride â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const notifyOtherNotifiedDriversRideTaken = async (
  ride: any,
  acceptedDriverId: string,
  io: any,
  passengerId?: string
) => {
  const notifiedDriverIds = (ride.notifiedDriverIds || [])
    .map((id: any) => id.toString())
    .filter((id: string) => id && id !== acceptedDriverId);

  if (!notifiedDriverIds.length) return;

  for (const otherDriverId of notifiedDriverIds) {
    io.to(`driver:${otherDriverId}`).emit('ride:already-taken', {
      rideId: ride._id.toString(),
      passengerId,
      acceptedDriverId,
      message: 'This ride has been accepted by another driver.',
    });
  }
};
const getDriverAvailableSeats = async (
  driverId: string,
  targetRideId: string,
  targetDate: string,
  targetTime: string,
  vehicleTotalSeats: number
): Promise<number> => {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const targetMinutes = toMinutes(targetTime);
  const TRIP_DURATION_MINUTES = 60; // conservative estimate
  const targetStart = targetMinutes;
  const targetEnd = targetMinutes + TRIP_DURATION_MINUTES;

  // Find driver's rides on same date that overlap with target time window
  const overlappingRides = await Ride.find({
    driverId,
    _id: { $ne: targetRideId }, // exclude the ride being accepted
    departureDate: targetDate,
    status: { $in: [RIDE_STATUS.accepted, RIDE_STATUS.started] },
  })
    .select('departureTime bookedSeats type')
    .lean();

  let conflictingBookedSeats = 0;

  for (const r of overlappingRides) {
    const rideMinutes = toMinutes(r.departureTime);
    const rideEnd = rideMinutes + TRIP_DURATION_MINUTES;

    // Check time overlap
    const overlaps =
      (targetStart >= rideMinutes && targetStart < rideEnd) ||
      (rideMinutes >= targetStart && rideMinutes < targetEnd);

    if (overlaps) {
      conflictingBookedSeats += r.bookedSeats || 0;
    }
  }

  return vehicleTotalSeats - conflictingBookedSeats;
};

export const driverAcceptRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    // â”€â”€ Driver details from Redis (fallback to DB if TTL expired) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let driverDetails = await redis.hgetall(`driver:${driverId}:details`);
    if (!driverDetails || !Object.keys(driverDetails).length) {
      const driverUser = await User.findById(driverId)
        .select('name email phone avgRating profileImage isOnline')
        .lean();

      if (!driverUser?.isOnline)
        return callback?.({
          success: false,
          message: 'Driver data not found. Please go online first.',
        });

      const driverVehicle = await Vehicle.findOne({
        userId: driverId,
        isDefault: true,
        isDeleted: false,
      }).lean();

      driverDetails = {
        name: driverUser.name || '',
        email: driverUser.email || '',
        phone: driverUser.phone || '',
        rating: (driverUser.avgRating || 0).toString(),
        photo: driverUser.profileImage || '',
        vehicleModel: driverVehicle?.name || '',
        vehicleNumber: driverVehicle?.number || '',
        seats: (driverVehicle?.seats || 4).toString(),
        bookedSeats: '0',
        status: 'online',
        lastUpdate: Date.now().toString(),
      };

      await redis.hset(`driver:${driverId}:details`, driverDetails);
      await redis.expire(`driver:${driverId}:details`, 7200);
    }

    // â”€â”€ Driver's default vehicle â€” DB à¦¥à§‡à¦•à§‡ (Redis stale à¦¹à¦¤à§‡ à¦ªà¦¾à¦°à§‡) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const defaultVehicle = await Vehicle.findOne({
      userId: driverId,
      isDefault: true,
      isDeleted: false,
    })
      .select('_id seats')
      .lean();

    const vehicleId = defaultVehicle?._id ?? null;
    // âœ… DB à¦¥à§‡à¦•à§‡ vehicle seats à¦¨à¦¾à¦“
    const vehicleTotalSeats =
      defaultVehicle?.seats || parseInt(driverDetails.seats) || 4;

    // â”€â”€ Ride â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });

    if (
      ride.status !== RIDE_STATUS.pending &&
      ride.status !== RIDE_STATUS.accepted
    )
      return callback?.({
        success: false,
        message: 'This ride has already been accepted or cancelled.',
      });

    // âœ… Available seats: same date + overlapping time à¦à¦° rides à¦¬à¦¾à¦¦ à¦¦à¦¿à¦¯à¦¼à§‡
    const availableSeats = await getDriverAvailableSeats(
      driverId,
      rideId,
      ride.departureDate,
      ride.departureTime,
      vehicleTotalSeats
    );

    socket.join(`ride:${rideId}`);
    socket.join(`driver:${driverId}`);

    // â”€â”€ PRIVATE RIDE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: { $in: [PASSENGER_STATUS.pending] },
        })
        : await Passenger.findOne({
          rideId,
          status: { $in: [PASSENGER_STATUS.pending] },
        });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'No pending passenger found',
        });

      const booking = await Booking.findOne({ passengerId: passenger._id, rideId: ride._id });
      if (!booking || ![PAYMENT_STATUS.authorized, PAYMENT_STATUS.paid].includes(booking.paymentStatus as any))
        return callback?.({
          success: false,
          message: 'Passenger payment is not completed yet.',
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

      const assignedRide = await Ride.findOneAndUpdate(
        {
          _id: rideId,
          status: RIDE_STATUS.pending,
          $or: [{ driverId: { $exists: false } }, { driverId: null }],
        },
        {
          driverId,
          vehicleId,
          status: RIDE_STATUS.accepted,
          notifiedDriverIds: [driverId],
          ...(ride.totalSeats === 0 && { totalSeats: vehicleTotalSeats }),
        },
        { new: true }
      );

      if (!assignedRide)
        return callback?.({
          success: false,
          message: 'This ride has already been accepted by another driver.',
        });

      await notifyOtherNotifiedDriversRideTaken(ride, driverId, io, passenger._id.toString());

      booking.userId = passenger.userId as any;
      booking.driverId = driverId as any;
      booking.totalFare = passenger.estimatedFare;
      booking.bookingStatus = BOOKING_STATUS.accepted;
      await booking.save();

      await PaymentService.captureAuthorizedBookingPayment(
        booking._id.toString(),
        driverId
      );

      notifyAdminForNewPendingBooking(booking).catch(() => { });

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      const riderUser = await User.findById(passenger.userId)
        .select('fcmToken')
        .lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Driver Accepted Your Ride!',
          description: `Your driver is on the way. ETA: ${estimatedArrival} minutes.`,
          reference: passenger._id.toString(),
          modelType: modeType.Passenger,
        }).catch(() => { });
      }

      await cancelOtherPendingRequests(passenger.userId.toString(), rideId, io);
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
        `âœ… Private accepted | rideId: ${rideId} | eta: ${estimatedArrival}min`
      );

      return callback?.({
        success: true,
        message: 'Private ride accepted successfully',
        data: { bookingId: booking._id, estimatedArrival },
      });
    }

    // â”€â”€ SPLIT RIDE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      const booking = await Booking.findOne({ passengerId: passenger._id, rideId: ride._id });
      if (!booking || ![PAYMENT_STATUS.authorized, PAYMENT_STATUS.paid].includes(booking.paymentStatus as any))
        return callback?.({
          success: false,
          message: 'Passenger payment is not completed yet.',
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

      if (ride.driverId && ride.driverId.toString() !== driverId)
        return callback?.({
          success: false,
          message: 'This ride has already been assigned to another driver.',
        });

      const rideUpdate: Record<string, any> = {};
      let assignedThisRide = false;
      if (!ride.driverId) {
        rideUpdate.driverId = driverId;
        rideUpdate.vehicleId = vehicleId;
        rideUpdate.notifiedDriverIds = [driverId];
        if (ride.totalSeats === 0) rideUpdate.totalSeats = vehicleTotalSeats;
        assignedThisRide = true;
      }
      if (isLastPassenger) rideUpdate.status = RIDE_STATUS.accepted;

      if (Object.keys(rideUpdate).length) {
        const assignedRide = await Ride.findOneAndUpdate(
          {
            _id: rideId,
            $or: [
              { driverId: driverId },
              { driverId: { $exists: false } },
              { driverId: null },
            ],
          },
          rideUpdate,
          { new: true }
        );

        if (!assignedRide)
          return callback?.({
            success: false,
            message: 'This ride has already been assigned to another driver.',
          });

        if (assignedThisRide) {
          await notifyOtherNotifiedDriversRideTaken(ride, driverId, io, passenger._id.toString());
        }
      }

      booking.userId = passenger.userId as any;
      booking.driverId = driverId as any;
      booking.totalFare = passenger.estimatedFare;
      booking.bookingStatus = BOOKING_STATUS.accepted;
      await booking.save();
      await Ride.findByIdAndUpdate(ride._id, {
        $inc: {
          bookedSeats: passenger.requestedSeats || 1,
          malePassengers: passenger.malePassengers || 0,
          femalePassengers: passenger.femalePassengers || 0,
        },
      });

      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        passenger.requestedSeats || 1
      );

      const existingChat = await Chat.findOne({ booking: booking._id });
      if (!existingChat) {
        await Chat.create({
          booking: booking._id,
          participants: [booking.userId, booking.driverId as any],
          status: CHAT_STATUS.accepted,
        });
      }

      notifyAdminForNewPendingBooking(booking).catch(() => { });

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      const riderUser = await User.findById(passenger.userId)
        .select('fcmToken')
        .lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Driver Accepted Your Split Ride!',
          description: `Your booking is confirmed. ETA: ${estimatedArrival} minutes.`,
          reference: passenger._id.toString(),
          modelType: modeType.Passenger,
        }).catch(() => { });
      }

      await cancelOtherPendingRequests(passenger.userId.toString(), rideId, io);
      await recalculateSplitFares(rideId, 'passenger_joined', io);

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

      io.to(`user:${passenger.userId.toString()}`).emit('ride:driver-accepted', payload);
      console.log(
        `âœ… Split accepted | passengerId: ${passengerId} | remaining: ${remainingCount} | eta: ${estimatedArrival}min`
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




