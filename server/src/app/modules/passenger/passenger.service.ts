import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Passenger } from './passenger.model';
import { Ride } from '../ride/ride.model';
import { PASSENGER_STATUS } from './passenger.constant';
import { RIDE_STATUS } from '../ride/ride.constant';
import { Booking } from '../booking/booking.model';
import { Provider } from '../provider/provider.model';
import { getRedisClient } from '../../config/redis.config';
import { buildStoredFareBreakdown } from '../../utils/fareBreakdownResponse.utils';
import { toRiderPriceView } from '../../utils/riderPriceResponse.utils';
import { extractIncludedVat, roundMoney } from '../../utils/fareMath.utils';
import { toLuggageFyiView } from '../../utils/luggage.utils';
import {
  TRequester,
  assertCanViewRide,
  canSeeDriverContact,
  canSeeRiderContact,
  isAdmin,
  maskUserContact,
} from '../../utils/contactPrivacy.utils';

const LUGGAGE_SELECT =
  'largeSuitcase smallSuitcase luggageNote luggageCounts note';

const getDriverRideRequest = async (driverUserId: string) => {
  // Find rides where the user is a passenger and the ride is pending
  const pendingRides = await Ride.find({
    notifiedDriverIds: driverUserId,
    $or: [
      { status: RIDE_STATUS.pending },
      { status: RIDE_STATUS.accepted, driverId: driverUserId },
    ],
  })
    .select('_id totalSeats')
    .lean();

  if (!pendingRides.length) return [];

  const redis = getRedisClient();
  const visibleRides = [];
  for (const ride of pendingRides) {
    const rejected = await redis.sismember(
      `ride:rejected:${ride._id}`,
      driverUserId
    );
    if (!rejected) visibleRides.push(ride);
  }

  if (!visibleRides.length) return [];

  const rideIds = visibleRides.map((ride) => ride._id);
  const passengerRides = await Passenger.find({
    rideId: { $in: rideIds },
    status: PASSENGER_STATUS.pending,
  })
    .populate([
      {
        path: 'rideId',
        select: 'id type',
      },
      {
        path: 'userId',
        select: 'name profileImage',
      },
    ])
    .select(
      `userId rideId pickup destination departureDate departureTime requestedSeats estimatedDistanceKm estimatedFare status createdAt ${LUGGAGE_SELECT}`
    )
    .sort({ createdAt: -1 })
    .lean();

  // One row per ride (the driver's card is keyed by rideId and one Accept takes
  // the whole ride). It used to be one row per rider, so a 2-rider split ride
  // showed as two cards. The row keeps the old per-rider fields, taken from the
  // first rider who booked (`_id` is that rider's passenger id), and adds the
  // ride totals and every pending rider in `passengers`.
  const totalSeatsByRide = new Map(
    visibleRides.map((r: any) => [String(r._id), Number(r.totalSeats || 0)]),
  );
  // Before acceptance the ride has no vehicle (totalSeats 0): use this driver's own seats.
  let driverSeats = 4;
  try {
    const n = Number(await redis.hget(`driver:${driverUserId}:details`, 'seats'));
    if (Number.isFinite(n) && n > 0) driverSeats = n;
  } catch {
    /* keep the default */
  }

  const groups = new Map<string, any[]>();
  for (const p of passengerRides) {
    const key = String((p as any).rideId?._id ?? (p as any).rideId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const rows = [...groups.entries()].map(([rideId, riders]) => {
    const oldestFirst = [...riders].sort(
      (a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const first: any = oldestFirst[0];
    const newest = riders[0] as any; // input is sorted newest first
    const rideTotalSeats = totalSeatsByRide.get(rideId) || 0;
    return {
      ...first,
      ...toLuggageFyiView(first),
      rideShortId: first.rideId?.id ?? null,
      rideType: first.rideId?.type ?? null,
      riders: oldestFirst.length,
      bookedSeats: oldestFirst.reduce((s: number, p: any) => s + (Number(p.requestedSeats) || 1), 0),
      totalSeats: rideTotalSeats > 0 ? rideTotalSeats : driverSeats,
      totalFare: roundMoney(oldestFirst.reduce((s: number, p: any) => s + Number(p.estimatedFare || 0), 0)),
      passengers: oldestFirst.map((p: any) => ({
        passengerId: String(p._id),
        user: p.userId,
        pickup: p.pickup,
        destination: p.destination,
        requestedSeats: Number(p.requestedSeats) || 1,
        estimatedDistanceKm: p.estimatedDistanceKm,
        estimatedFare: Number(p.estimatedFare || 0),
        createdAt: p.createdAt,
        ...toLuggageFyiView(p),
      })),
      lastUpdatedAt: newest.createdAt,
    };
  });

  // Newest activity first, as before.
  return rows.sort(
    (a: any, b: any) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime(),
  );
};

// Get all passengers for a ride
const getPassengersByRide = async (rideId: string, requester?: TRequester) => {
  const rideAccess = await Ride.findById(rideId)
    .select('driverId notifiedDriverIds rideCreatedBy')
    .lean();
  if (!rideAccess) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  const passengers = await Passenger.find({ rideId })
    .populate([
      { path: 'userId', select: 'name phone profileImage' },
      {
        path: 'rideId',
        select: 'driverId',
        populate: [
          {
            path: 'driverId',
            select: 'name email phone profileImage',
          },
        ],
      },
    ])
    .select(
      `userId pickup destination departureDate departureTime requestedSeats estimatedFare status createdAt ${LUGGAGE_SELECT}`
    )
    .sort({ createdAt: -1 })
    .lean();

  if (!passengers.length) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'No passengers found for this ride'
    );
  }

  // B-18: access check + contact masking until the driver accepted the passenger.
  assertCanViewRide(
    requester,
    rideAccess as any,
    passengers.map((p: any) => String(p.userId?._id ?? p.userId ?? '')),
  );
  const showDriverContact = canSeeDriverContact(requester, rideAccess as any, passengers as any);

  return passengers.map((p: any) => {
    const ridePart = p.rideId && typeof p.rideId === 'object'
      ? {
          ...p.rideId,
          driverId: showDriverContact ? p.rideId.driverId : maskUserContact(p.rideId.driverId),
        }
      : p.rideId;
    return {
      ...p,
      userId: canSeeRiderContact(requester, rideAccess as any, p) ? p.userId : maskUserContact(p.userId),
      rideId: ridePart,
      ...toLuggageFyiView(p),
    };
  });
};

// Get single passenger by ID
const getPassengerById = async (passengerId: string, requester?: TRequester) => {
  const passenger = await Passenger.findById(passengerId)
    .populate([
      { path: 'userId', select: 'name phone profileImage' },
      {
        path: 'rideId',
        select: 'departureDate departureTime pickup destination driverId type currentSurchargePercent',
        populate: [
          {
            path: 'driverId',
            select: 'name email phone profileImage address',
          },
        ],
      },
    ])
    .lean();

  if (!passenger) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Passenger not found');
  }

  const ride = (passenger as any).rideId;

  // B-18: only the rider, the ride's (assigned or notified) driver, or an admin.
  if (requester && !isAdmin(requester)) {
    const rideAccess = ride?._id
      ? await Ride.findById(ride._id).select('driverId notifiedDriverIds rideCreatedBy').lean()
      : null;
    const riderId = String((passenger as any).userId?._id ?? (passenger as any).userId ?? '');
    if (rideAccess) {
      assertCanViewRide(requester, rideAccess as any, [riderId]);
    } else if (riderId !== String(requester.userId)) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'You do not have access to this passenger');
    }
    const rideRef = { driverId: (rideAccess as any)?.driverId };
    if (!canSeeRiderContact(requester, rideRef, passenger as any)) {
      (passenger as any).userId = maskUserContact((passenger as any).userId);
    }
    if (ride && !canSeeDriverContact(requester, rideRef, [passenger as any])) {
      ride.driverId = maskUserContact(ride.driverId);
    }
  }

  const driver = ride?.driverId;
  if (driver && typeof driver === 'object' && driver._id) {
    const provider = await Provider.findOne({ userId: driver._id })
      .select('vatNumber')
      .lean();
    driver.vatNumber = provider?.vatNumber || null;
  }

  const booking = await Booking.findOne({ passengerId })
    .select('id paymentStatus bookingStatus totalFare amountPaid')
    .lean();

  const fareBreakdown = await buildStoredFareBreakdown(
    passenger,
    booking,
    (passenger as any).rideId,
  );

  const price = toRiderPriceView({
    estimatedFare: Number(
      (passenger as any).totalFare ||
        (passenger as any).estimatedFare ||
        booking?.totalFare ||
        fareBreakdown.totalFare,
    ),
    vatAmount: fareBreakdown.vatAmount,
    vatPercentage: fareBreakdown.vatPercentage,
    vatIncluded: fareBreakdown.vatIncluded,
  });

  // Invoice: Trip Fee (net) + VAT + Total — net derived from locked gross.
  const lockedTotal = price.estimatedFare;
  const vatPercentage = price.vatPercentage;
  const vatAmount = extractIncludedVat(lockedTotal, vatPercentage);
  const tripFee = roundMoney(lockedTotal - vatAmount);

  return {
    ...passenger,
    ...price,
    ...toLuggageFyiView(passenger),
    vatAmount,
    tripFee,
    bookingId: booking?._id || null,
    bookingShortId: booking?.id || null,
    invoiceId: booking?.id || null,
  };
};

export const PassengerService = {
  getDriverRideRequest,
  getPassengersByRide,
  getPassengerById,
};








