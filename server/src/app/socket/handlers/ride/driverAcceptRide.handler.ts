// handlers/driver/driverAcceptRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
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
import { hasDriverRideAtDateTime } from '../../../utils/geo.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import onlineUsers from '../../utils/onlineUsers';
import eventHandler from '../../utils/eventHandler';
import { ILatLng } from '../../interface/ride';
import { sendNotification } from '../../../utils/sentPushNotification';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { modeType } from '../../../modules/notification/notification.interface';
import { PaymentService } from '../../../modules/payment/payment.service';
import { recalculateSplitFares } from '../../../utils/splitFare.utils';
import { getActiveSplitPassengersOnRide } from '../../../utils/splitMatching.utils';
import { getSplitMaxMatchedRiders } from '../../../utils/splitFare.utils';
import { buildStoredFareBreakdown } from '../../../utils/fareBreakdownResponse.utils';
import { toRiderPriceView } from '../../../utils/riderPriceResponse.utils';
import { toLuggageFyiView } from '../../../utils/luggage.utils';
import { buildWaitTimeNotice } from '../../../utils/waitTimeNotice.utils';
import { getAcceptBlockReason } from '../../../utils/acceptGuard.utils';
import { getDepartureDateTime } from '../../../utils/rideSchedule.utils';
import {
  isDriverKycVerified,
  KYC_NOT_VERIFIED_MESSAGE,
} from '../../../utils/kycGuard.utils';

// B-19: "Your driver is on the way. ETA: 6 minutes" was sent even for rides
// booked hours ahead. Rides more than 30 minutes out get a scheduled-ride text.
const SCHEDULED_RIDE_THRESHOLD_MS = 30 * 60 * 1000;
export const buildAcceptedPushDescription = (
  ride: { departureDate?: string; departureTime?: string } | null | undefined,
  etaText: string,
): string => {
  try {
    if (ride?.departureDate && ride?.departureTime) {
      const departAt = getDepartureDateTime(ride.departureDate, ride.departureTime);
      if (departAt.getTime() - Date.now() > SCHEDULED_RIDE_THRESHOLD_MS) {
        return `Your ride is confirmed for ${ride.departureDate} at ${ride.departureTime}.`;
      }
    }
  } catch {
    /* fall back to the ETA text */
  }
  return etaText;
};

type TAck = { success: boolean; message: string; data?: Record<string, any> };

const ensureRiderInRoom =(userId: string, rideId: string) => {
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
  ...toLuggageFyiView(passenger),
  ...extra,
});

// A rider may hold several independent bookings (different days/times). An
// accept on one must never touch the others: the old auto-cancel here left the
// card hold authorized, the Ride pending, and the rider uninformed.

// ──────────────────────────────────────────────────────────
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
// The driver tapped Accept on a card for a ride that can no longer be taken
// (the app missed the removal event, e.g. its socket was down). Besides the
// failed ack, tell that driver to drop the stale card so it is not retried.
const RIDE_UNAVAILABLE_CODE = 'RIDE_NOT_AVAILABLE';

const rideUnavailableMessage = (status?: string | null): string => {
  if (status === RIDE_STATUS.cancelled) {
    return 'This ride request was cancelled and is no longer available.';
  }
  if (
    status === RIDE_STATUS.arrived ||
    status === RIDE_STATUS.started ||
    status === RIDE_STATUS.completed
  ) {
    return 'This ride has already been accepted by another driver.';
  }
  return 'This ride is no longer available to accept.';
};

const removeStaleRequestCard = (
  io: any,
  driverId: string,
  rideId: string,
  rideStatus: string | null | undefined,
  message: string,
) => {
  try {
    io.to(`driver:${driverId}`).emit('ride:request-removed', {
      rideId,
      reason: RIDE_UNAVAILABLE_CODE,
      rideStatus: rideStatus ?? null,
      message,
    });
  } catch {
    /* best effort */
  }
};

const rideUnavailableAck = (
  io: any,
  driverId: string,
  rideId: string,
  rideStatus: string | null | undefined,
  message: string = rideUnavailableMessage(rideStatus),
) => {
  removeStaleRequestCard(io, driverId, rideId, rideStatus, message);
  return {
    success: false,
    code: RIDE_UNAVAILABLE_CODE,
    message,
    data: { rideId: String(rideId), rideStatus: rideStatus ?? null },
  };
};

export const driverAcceptRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    // ──────────────────────────────────────────────────────────
    // Check driver online status in DB first (offline drivers cannot accept rides)
    const driverUserCheck = await User.findById(driverId)
      .select('name email phone avgRating profileImage status isDeleted isOnline isKycVerified')
      .lean();

    if (!driverUserCheck || driverUserCheck.isDeleted) {
      return callback?.({
        success: false,
        message: 'Driver not found or unavailable.',
      });
    }

    // Dispatch never offers rides to unverified drivers; block a direct emit too.
    if (!isDriverKycVerified(driverUserCheck)) {
      return callback?.({ success: false, message: KYC_NOT_VERIFIED_MESSAGE });
    }

    if (!driverUserCheck.isOnline) {
      // Issue 58: this used to switch the driver online silently, while the
      // app still showed "offline". Offline drivers must go online first
      // (driver:go-online also validates their vehicle and location).
      socket.emit('driver:status', { isOnline: false });
      return callback?.({
        success: false,
        message: 'You are offline. Go online to accept rides.',
      });
    }

    let driverDetails = await redis.hgetall(`driver:${driverId}:details`);
    if (!driverDetails || !Object.keys(driverDetails).length) {
      const driverUser = driverUserCheck;

      const driverVehicle = await Vehicle.findOne({
        userId: driverId,
        isDefault: true,
        isDeleted: false,
      }).lean();

      if (!driverVehicle)
        return callback?.({
          success: false,
          message: 'No default vehicle set. Please set a default vehicle before accepting rides.',
        });

      driverDetails = {
        name: driverUser.name || '',
        email: driverUser.email || '',
        phone: driverUser.phone || '',
        rating: (driverUser.avgRating || 0).toString(),
        photo: driverUser.profileImage || '',
        vehicleModel: driverVehicle?.name || '',
        vehicleNumber: driverVehicle?.number || '',
        seats: driverVehicle.seats.toString(),
        bookedSeats: '0',
        status: 'online',
        lastUpdate: Date.now().toString(),
      };

      await redis.hset(`driver:${driverId}:details`, driverDetails);
      await redis.expire(`driver:${driverId}:details`, 86400);
    }

    // ──────────────────────────────────────────────────────────
    const defaultVehicle = await Vehicle.findOne({
      userId: driverId,
      isDefault: true,
      isDeleted: false,
    })
      .select('_id seats')
      .lean();

    const vehicleId = defaultVehicle?._id ?? null;
    // ──────────────────────────────────────────────────────────
    const vehicleTotalSeats =
      defaultVehicle?.seats || parseInt(driverDetails.seats) || 4;

    // ──────────────────────────────────────────────────────────
    const ride = await Ride.findById(rideId);
    if (!ride) {
      return callback?.(
        rideUnavailableAck(io, driverId, rideId, null, 'This ride is no longer available to accept.'),
      );
    }

    if (
      ride.status !== RIDE_STATUS.pending &&
      ride.status !== RIDE_STATUS.accepted
    ) {
      return callback?.(rideUnavailableAck(io, driverId, rideId, ride.status));
    }

    if (ride.driverId && ride.driverId.toString() !== driverId) {
      return callback?.(
        rideUnavailableAck(
          io,
          driverId,
          rideId,
          ride.status,
          'This ride has already been accepted by another driver.',
        ),
      );
    }

    // Busy rule (±60 min), first accept only. It was enforced when choosing
    // which drivers to notify, but a driver who had already received the
    // request (or re-notify) could still accept two overlapping rides.
    if (!ride.driverId && ride.departureDate && ride.departureTime) {
      const availability = await hasDriverRideAtDateTime(
        driverId,
        ride.departureDate,
        ride.departureTime,
        ride.type,
        1,
        ride._id.toString(),
      );
      if (!availability.available) {
        return callback?.({
          success: false,
          code: 'DRIVER_BUSY',
          message: 'You have another ride at this time.',
          data: { reason: availability.reason },
        });
      }
    }

    socket.join(`ride:${rideId}`);
    socket.join(`driver:${driverId}`);

    // ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      // Accept-time: no seats gates, but a cancelled/refunded passenger is rejected below.
      const passenger = passengerId
        ? await Passenger.findOne({ _id: passengerId, rideId }) ||
          await Passenger.findById(passengerId)
        : await Passenger.findOne({ rideId });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'Passenger not found',
        });

      const booking =
        (await Booking.findOne({ passengerId: passenger._id, rideId: ride._id })) ||
        (await Booking.findOne({ passengerId: passenger._id }));
      if (!booking) {
        return callback?.({
          success: false,
          message: 'Booking not found for this passenger.',
        });
      }

      const privateBlock = getAcceptBlockReason(passenger, booking);
      if (privateBlock) return callback?.({ success: false, message: privateBlock });

      const pickupLat = passenger.pickup.coordinates[1];
      const pickupLng = passenger.pickup.coordinates[0];
      const estimatedArrival = await calcEstimatedArrival(
        redis,
        driverId,
        pickupLat,
        pickupLng
      );

      // Resume if this driver already claimed (common after capture mid-fail),
      // otherwise atomically claim an unassigned pending ride.
      const alreadyClaimedByMe =
        ride.driverId?.toString() === driverId &&
        (ride.status === RIDE_STATUS.accepted || ride.status === RIDE_STATUS.pending);

      let assignedRide = alreadyClaimedByMe ? ride : null;

      if (!assignedRide) {
        assignedRide = await Ride.findOneAndUpdate(
          {
            _id: rideId,
            status: RIDE_STATUS.pending,
            $or: [{ driverId: { $exists: false } }, { driverId: null }],
          },
          {
            $set: {
              driverId,
              vehicleId,
              status: RIDE_STATUS.accepted,
              ...(ride.totalSeats === 0 ? { totalSeats: vehicleTotalSeats } : {}),
            },
            $addToSet: { notifiedDriverIds: driverId },
          },
          { new: true },
        );
      } else if (ride.totalSeats === 0 || !ride.vehicleId) {
        assignedRide = await Ride.findByIdAndUpdate(
          rideId,
          {
            $set: {
              vehicleId: ride.vehicleId || vehicleId,
              status: RIDE_STATUS.accepted,
              ...(ride.totalSeats === 0 ? { totalSeats: vehicleTotalSeats } : {}),
            },
            $addToSet: { notifiedDriverIds: driverId },
          },
          { new: true },
        );
      }

      if (!assignedRide) {
        // Lost a race: another driver took it, or the rider cancelled meanwhile.
        const current = await Ride.findById(rideId).select('driverId status').lean();
        if (current?.driverId && current.driverId.toString() !== driverId) {
          return callback?.(
            rideUnavailableAck(
              io,
              driverId,
              rideId,
              current.status,
              'This ride has already been accepted by another driver.',
            ),
          );
        }
        return callback?.(rideUnavailableAck(io, driverId, rideId, current?.status));
      }

      // Do NOT save booking before capture — that + long Stripe txn caused Mongo write conflicts.
      // Capture links driver, marks paid/accepted, increments seats, creates chat.
      try {
        await PaymentService.captureAuthorizedBookingPayment(
          booking._id.toString(),
          driverId,
          {
            incrementRideSeats: true,
            createChat: true,
            recalculateSplit: false,
            updateBookingStatus: true,
          },
        );
      } catch (captureErr: any) {
        console.error(
          `Private accept capture failed | rideId=${rideId} driverId=${driverId}:`,
          captureErr?.message || captureErr,
        );

        // Issue 8: the ride used to stay "accepted" by this driver while the rider
        // got nothing, and the no-driver job no longer looked at it. If no money
        // moved, give the ride back to the search and tell the rider. If money
        // WAS captured (or we can't tell), keep the claim: a retry by the same
        // driver completes safely because Stripe reports the intent as succeeded.
        if (!alreadyClaimedByMe) {
          const captureState = await PaymentService.getBookingCaptureState(
            booking._id.toString(),
          );
          if (captureState === 'not_captured') {
            await Ride.findOneAndUpdate(
              { _id: rideId, driverId, status: RIDE_STATUS.accepted },
              {
                $set: { status: RIDE_STATUS.pending },
                $unset: { driverId: '', vehicleId: '' },
              },
            );
            await notifyUserPush({
              userId: passenger.userId.toString(),
              message: 'Payment Needs Attention',
              description:
                'A driver tried to accept your ride but the payment could not be completed. Please check your payment method.',
              reference: passenger._id.toString(),
              modelType: modeType.Passenger,
              dedupeKey: `accept-capture-failed:${passenger._id.toString()}`,
              dedupeTtlSeconds: 30 * 60,
              data: {
                type: 'PAYMENT_ACTION_REQUIRED',
                rideId: String(rideId),
                passengerId: passenger._id.toString(),
              },
            }).catch(() => {});
          }
        }

        return callback?.({
          success: false,
          message:
            captureErr?.message ||
            'Payment capture failed. Please try accepting again.',
        });
      }

      // B-01: a wallet booking is already "paid" before any driver accepts, so the
      // capture above returns early and never counts the seats (the driver saw
      // "Booked Seats: 0"). A private ride has exactly one passenger, so set the
      // counters to that passenger's values. This is idempotent on retries.
      await Ride.findByIdAndUpdate(rideId, {
        $set: {
          bookedSeats: Number(passenger.requestedSeats) || 1,
          malePassengers: Number(passenger.malePassengers) || 0,
          femalePassengers: Number(passenger.femalePassengers) || 0,
        },
      });

      // Only now is the ride really taken: tell the other drivers.
      if (!alreadyClaimedByMe) {
        await notifyOtherNotifiedDriversRideTaken(ride, driverId, io, passenger._id.toString());
      }

      // Refresh booking after capture for response payload
      const refreshedBooking = await Booking.findById(booking._id);
      if (refreshedBooking) {
        booking.userId = refreshedBooking.userId as any;
        booking.driverId = refreshedBooking.driverId as any;
        booking.totalFare = refreshedBooking.totalFare;
        booking.bookingStatus = refreshedBooking.bookingStatus;
        booking.paymentStatus = refreshedBooking.paymentStatus;
        booking.amountPaid = refreshedBooking.amountPaid;
      } else {
        booking.userId = passenger.userId as any;
        booking.driverId = driverId as any;
        booking.totalFare = passenger.estimatedFare;
        booking.bookingStatus = BOOKING_STATUS.accepted;
      }

      const alreadyAccepted = [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
        PASSENGER_STATUS.picked_up,
        PASSENGER_STATUS.dropped_off,
        PASSENGER_STATUS.completed,
      ].includes(passenger.status as any);
      const firstAccept = !alreadyAccepted;

      if (firstAccept) {
        notifyAdminForNewPendingBooking(booking).catch(() => { });
      }

      passenger.status = PASSENGER_STATUS.confirmed;
      await passenger.save();

      await redis.hset(`ride:active:${rideId}`, {
        driverId,
        status: RIDE_STATUS.accepted,
        startedAt: Date.now().toString(),
        passengerCount: '1',
      });
      await redis.expire(`ride:active:${rideId}`, 7200);
      await redis.set(`driver:${driverId}:activeRide`, rideId, 'EX', 7200);

      ensureRiderInRoom(passenger.userId.toString(), rideId);

      const fareBreakdown = await buildStoredFareBreakdown(passenger, booking, ride);
      const price = toRiderPriceView({
        estimatedFare: Number(passenger.estimatedFare || booking.totalFare || fareBreakdown.totalFare),
        vatAmount: fareBreakdown.vatAmount,
        vatPercentage: fareBreakdown.vatPercentage,
        vatIncluded: fareBreakdown.vatIncluded,
      });

      const payload = buildAcceptedPayload(
        rideId,
        passenger,
        booking,
        driverId,
        driverDetails,
        socket,
        estimatedArrival,
        { rideFullyAccepted: true, ...price, waitTimeNotice: buildWaitTimeNotice() }
      );

      io.to(`user:${passenger.userId.toString()}`)
        .to(`ride:${rideId}`)
        .emit('ride:driver-accepted', payload);
      console.log(
        `Private accepted | rideId: ${rideId} | eta: ${estimatedArrival}min`
      );

      // Issue 8: the push used to run BEFORE the socket event (and the event waited
      // for the FCM round trip). The live screen is updated first now.
      if (firstAccept) {
        await notifyUserPush({
          userId: passenger.userId.toString(),
          message: 'Driver Accepted Your Ride!',
          description: buildAcceptedPushDescription(
            ride as any,
            `Your driver is on the way. ETA: ${estimatedArrival} minutes.`,
          ),
          reference: passenger._id.toString(),
          modelType: modeType.Passenger,
          dedupeKey: `ride-accepted:${passenger._id.toString()}`,
          data: {
            type: 'RIDE_ACCEPTED',
            rideId: String(rideId),
            passengerId: passenger._id.toString(),
          },
        });
      }

      return callback?.({
        success: true,
        message: 'Private ride accepted successfully',
        data: { bookingId: booking._id, estimatedArrival, ...price },
      });
    }

    // ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      // Accepts one rider. Returns the ack it would send instead of sending it,
      // so the whole-ride accept below can run it once per pending rider.
      const acceptSplitPassenger = async (passenger: any, wholeRide: boolean): Promise<TAck> => {
        const booking =
          (await Booking.findOne({ passengerId: passenger._id, rideId: ride._id })) ||
          (await Booking.findOne({ passengerId: passenger._id }));
        if (!booking) {
          return {
            success: false,
            message: 'Booking not found for this passenger.',
          };
        }

        const splitBlock = getAcceptBlockReason(passenger, booking);
        if (splitBlock) return { success: false, message: splitBlock };

        const pickupLat = passenger.pickup.coordinates[1];
        const pickupLng = passenger.pickup.coordinates[0];
        const estimatedArrival = await calcEstimatedArrival(
          redis,
          driverId,
          pickupLat,
          pickupLng
        );

        // Only riders inside the max cap block "fully accepted"; overflow pending ignored.
        const maxMatchedRiders = await getSplitMaxMatchedRiders();
        const activeSorted = await getActiveSplitPassengersOnRide(rideId);
        const remainingCount = activeSorted
          .slice(0, maxMatchedRiders)
          .filter(
            (p: any) =>
              p._id.toString() !== passenger._id.toString() &&
              p.status === PASSENGER_STATUS.pending,
          ).length;
        const isLastPassenger = remainingCount === 0;

        if (ride.driverId && ride.driverId.toString() !== driverId)
          return {
            success: false,
            message: 'This ride has already been assigned to another driver.',
          };

        const rideUpdate: Record<string, any> = {};
        let assignedThisRide = false;
        if (!ride.driverId) {
          rideUpdate.driverId = driverId;
          rideUpdate.vehicleId = vehicleId;
          rideUpdate.notifiedDriverIds = [driverId];
          if (ride.totalSeats === 0) rideUpdate.totalSeats = vehicleTotalSeats;
          assignedThisRide = true;
        }
        // Mark ride as accepted as soon as a driver accepts the first passenger
        // so noDriverFound job does not cancel/refund an accepted split ride.
        rideUpdate.status = RIDE_STATUS.accepted;

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
            { returnDocument: 'after' }
          );

          if (!assignedRide)
            return {
              success: false,
              message: 'This ride has already been assigned to another driver.',
            };

          if (assignedThisRide) {
            // Whole-ride accept: the other drivers drop the whole card, so no passengerId.
            await notifyOtherNotifiedDriversRideTaken(
              ride,
              driverId,
              io,
              wholeRide ? undefined : passenger._id.toString(),
            );
            // Keep the in-memory ride in step, so the next rider of a whole-ride
            // accept does not re-assign it or tell the other drivers again.
            ride.driverId = assignedRide.driverId;
            ride.totalSeats = assignedRide.totalSeats;
          }
        }

        await redis.zrem('ride:matching:queue', ride._id.toString());

        booking.userId = passenger.userId as any;
        booking.driverId = driverId as any;
        booking.totalFare = passenger.estimatedFare;
        booking.bookingStatus = BOOKING_STATUS.accepted;
        await booking.save();

        const activePassengersAfterAccept = await getActiveSplitPassengersOnRide(ride._id);
        const exactBookedSeats = activePassengersAfterAccept.reduce(
          (sum: number, p: any) => sum + (Number(p.requestedSeats) || 1),
          0,
        );

        await Ride.findByIdAndUpdate(ride._id, {
          $set: { bookedSeats: exactBookedSeats },
          $inc: {
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

        const alreadyAccepted = [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.driver_arrived,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.picked_up,
          PASSENGER_STATUS.dropped_off,
          PASSENGER_STATUS.completed,
        ].includes(passenger.status as any);
        const firstAccept = !alreadyAccepted;

        if (firstAccept) {
          notifyAdminForNewPendingBooking(booking).catch(() => { });
        }

        passenger.status = PASSENGER_STATUS.confirmed;
        await passenger.save();

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

        const refreshedPassenger = await Passenger.findById(passenger._id).lean() || passenger;
        const fareBreakdown = await buildStoredFareBreakdown(refreshedPassenger, booking, ride);
        const price = toRiderPriceView({
          estimatedFare: Number(
            (refreshedPassenger as any).estimatedFare ||
              booking.totalFare ||
              fareBreakdown.totalFare,
          ),
          vatAmount: fareBreakdown.vatAmount,
          vatPercentage: fareBreakdown.vatPercentage,
          vatIncluded: fareBreakdown.vatIncluded,
        });

        const payload = buildAcceptedPayload(
          rideId,
          refreshedPassenger,
          booking,
          driverId,
          driverDetails,
          socket,
          estimatedArrival,
          {
            rideFullyAccepted: isLastPassenger,
            remainingPassengers: remainingCount,
            ...price,
            waitTimeNotice: buildWaitTimeNotice(),
          }
        );

        io.to(`user:${passenger.userId.toString()}`)
          .to(`ride:${rideId}`)
          .emit('ride:driver-accepted', payload);
        console.log(
          `Split accepted | passengerId: ${passenger._id} | remaining: ${remainingCount} | eta: ${estimatedArrival}min`
        );

        // Socket event first, then the push (issue 8).
        if (firstAccept) {
          await notifyUserPush({
            userId: passenger.userId.toString(),
            message: 'Driver Accepted Your Split Ride!',
            description: buildAcceptedPushDescription(
              ride as any,
              `Your booking is confirmed. ETA: ${estimatedArrival} minutes.`,
            ),
            reference: passenger._id.toString(),
            modelType: modeType.Passenger,
            dedupeKey: `ride-accepted:${passenger._id.toString()}`,
            data: {
              type: 'RIDE_ACCEPTED',
              rideId: String(rideId),
              passengerId: passenger._id.toString(),
            },
          });
        }

        return {
          success: true,
          message: isLastPassenger
            ? 'Passenger accepted. All passengers confirmed.'
            : `Passenger accepted. ${remainingCount} still pending.`,
          data: {
            passengerId: passenger._id,
            bookingId: booking._id,
            estimatedArrival,
            rideFullyAccepted: isLastPassenger,
            remainingPassengers: remainingCount,
            ...price,
          },
        };
      };

      // Legacy: accept one rider (passengerId given).
      if (passengerId) {
        const passenger =
          (await Passenger.findOne({ _id: passengerId, rideId })) ||
          (await Passenger.findById(passengerId));
        if (!passenger)
          return callback?.({
            success: false,
            message: 'Passenger not found for this split ride',
          });
        return callback?.(await acceptSplitPassenger(passenger, false));
      }

      // One Accept takes the whole ride: every pending rider inside the rider cap,
      // oldest first. The driver card is one per ride (keyed by rideId), so this is
      // what its Accept button means. A rider who cannot be accepted yet (e.g. must
      // re-authorize an increased fare) is skipped, stays pending, and is listed in
      // `skippedPassengers`; the driver can accept them later by passengerId.
      const maxMatchedRiders = await getSplitMaxMatchedRiders();
      const pendingIds = (await getActiveSplitPassengersOnRide(rideId))
        .slice(0, maxMatchedRiders)
        .filter((p: any) => p.status === PASSENGER_STATUS.pending)
        .map((p: any) => String(p._id));

      if (!pendingIds.length) {
        // Nothing left to take (riders cancelled / matched elsewhere): the card is stale.
        if (!ride.driverId) {
          return callback?.(
            rideUnavailableAck(
              io,
              driverId,
              rideId,
              ride.status,
              'No pending passengers to accept on this ride.',
            ),
          );
        }
        return callback?.({
          success: false,
          message: 'No pending passengers to accept on this ride.',
        });
      }

      const accepted: any[] = [];
      const skipped: Array<{ passengerId: string; message: string }> = [];
      for (const id of pendingIds) {
        const passenger = await Passenger.findOne({ _id: id, rideId, status: PASSENGER_STATUS.pending });
        if (!passenger) continue; // cancelled meanwhile
        const result = await acceptSplitPassenger(passenger, true);
        if (result.success) {
          accepted.push(result.data);
        } else {
          skipped.push({ passengerId: id, message: result.message });
          // Another driver took the ride: nothing else on it can be accepted.
          if (result.message === 'This ride has already been assigned to another driver.') break;
        }
      }

      if (!accepted.length) {
        if (skipped[0]?.message === 'This ride has already been assigned to another driver.') {
          removeStaleRequestCard(io, driverId, rideId, ride.status, skipped[0].message);
        }
        // Same shape as a single-rider failure, with the per-rider reasons attached.
        return callback?.({
          success: false,
          message: skipped[0]?.message || 'No pending passengers to accept on this ride.',
          data: { skippedPassengers: skipped },
        });
      }

      const last = accepted[accepted.length - 1];
      const rideFullyAccepted = Boolean(last.rideFullyAccepted);
      return callback?.({
        success: true,
        message: rideFullyAccepted
          ? 'Ride accepted. All passengers confirmed.'
          : 'Ride accepted. Some passengers could not be accepted yet.',
        data: {
          rideId: String(rideId),
          rideFullyAccepted,
          remainingPassengers: last.remainingPassengers,
          acceptedPassengers: accepted.map((a) => ({
            passengerId: String(a.passengerId),
            bookingId: String(a.bookingId),
            estimatedArrival: a.estimatedArrival,
            estimatedFare: a.estimatedFare,
          })),
          skippedPassengers: skipped,
          // First rider's values at the top level, as in a single-rider accept, for older builds.
          bookingId: accepted[0].bookingId,
          estimatedArrival: accepted[0].estimatedArrival,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  }
);









