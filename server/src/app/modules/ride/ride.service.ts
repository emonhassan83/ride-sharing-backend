import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { RIDE_STATUS } from './ride.constant';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS, PAYMENT_STATUS } from '../passenger/passenger.constant';
import { Booking } from '../booking/booking.model';

const getAllIntoDB = async (query: Record<string, unknown>) => {
  // ── Filter type: scheduled | completed | all (default) ───────────────────
  const status = query.status as string | undefined;
  delete query.status;

  let statusFilter: any;

  if (status === 'scheduled') {
    statusFilter = {
      status: { $in: [RIDE_STATUS.accepted, RIDE_STATUS.started] },
    };
  } else if (status === 'completed') {
    statusFilter = {
      status: RIDE_STATUS.completed,
    };
  } else {
    // default — exclude pending, cancelled, rejected
    statusFilter = {
      status: {
        $nin: [
          RIDE_STATUS.pending,
          RIDE_STATUS.cancelled,
          RIDE_STATUS.rejected,
        ],
      },
    };
  }

  const rideQuery = new QueryBuilder(
    Ride.find(statusFilter)
      .populate([
        { path: 'driverId', select: 'name' },
        { path: 'rideCreatedBy', select: 'name' },
      ])
      .select(
        'pickup destination departureDate departureTime bookedSeats status createdAt type driverId rideCreatedBy'
      ),
    query
  )
    .filter()
    .sort()
    .paginate()
    .fields();

  const [result, meta] = await Promise.all([
    rideQuery.modelQuery,
    rideQuery.countTotal(),
  ]);

  return { meta, result };
};

const getDriverRides = async (
  userId: string,
  query: Record<string, unknown>
) => {
  // 1. Fetch all rides for the driver that are not pending/cancelled/rejected
  const driverRides = await Ride.find({
    driverId: userId,
    status: {
      $nin: [
        RIDE_STATUS.pending,
        RIDE_STATUS.cancelled,
        RIDE_STATUS.rejected,
      ],
    },
  }).select('_id');

  const driverRideIds = driverRides.map(r => r._id);

  // 2. Fetch all passengers of these rides who are not pending/cancelled/rejected
  const passengers = await Passenger.find({
    rideId: { $in: driverRideIds },
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
      ],
    },
  }).select('rideId paymentStatus');

  // 3. Count passengers per ride and check payment status
  const ridePassengerMap = new Map<string, { count: number; hasPaid: boolean }>();
  for (const p of passengers) {
    const rideIdStr = p.rideId.toString();
    if (!ridePassengerMap.has(rideIdStr)) {
      ridePassengerMap.set(rideIdStr, { count: 0, hasPaid: false });
    }
    const info = ridePassengerMap.get(rideIdStr)!;
    info.count += 1;
    if (p.paymentStatus === PAYMENT_STATUS.paid) {
      info.hasPaid = true;
    }
  }

  // 4. Identify eligible rides:
  // - Show if passenger count > 1
  // - Show if passenger count === 1 and that passenger has paid (paymentStatus is 'paid')
  const eligibleRideIds: string[] = [];
  for (const [rideIdStr, info] of ridePassengerMap.entries()) {
    if (info.count > 1 || (info.count === 1 && info.hasPaid)) {
      eligibleRideIds.push(rideIdStr);
    }
  }

  // 5. If no rides are eligible, return empty result with pagination metadata
  if (!eligibleRideIds.length) {
    return {
      meta: {
        page: Number(query.page) || 1,
        limit: Number(query.limit) || 10,
        total: 0,
        totalPage: 0,
      },
      result: [],
    };
  }

  const rideQuery = new QueryBuilder(
    Ride.find({
      _id: { $in: eligibleRideIds },
    })
      .populate([
        { path: 'driverId', select: 'name' },
        { path: 'rideCreatedBy', select: 'name' },
      ])
      .select(
        'id pickup destination departureDate departureTime bookedSeats status createdAt type driverId rideCreatedBy'
      ),
    query
  )
    .filter()
    .sort()
    .paginate()
    .fields();

  const [result, meta] = await Promise.all([
    rideQuery.modelQuery,
    rideQuery.countTotal(),
  ]);

  if (!result.length) return { meta, result };

  const rideIds = result.map(r => r._id);
  const allPassengers = await Passenger.find({
    rideId: { $in: rideIds },
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
      ],
    },
  })
    .populate('userId', 'name')
    .lean();

  const passengerMap = new Map<string, string[]>();
  for (const p of allPassengers) {
    const rideId = typeof p.rideId === 'object' && p.rideId
      ? (p.rideId as any)._id || p.rideId
      : p.rideId;
    const rideIdStr = rideId.toString();
    if (!passengerMap.has(rideIdStr)) {
      passengerMap.set(rideIdStr, []);
    }
    const userName = (p as any).userId?.name || '';
    if (userName) {
      passengerMap.get(rideIdStr)!.push(userName);
    }
  }

  const resultWithPassengers = result.map(ride => ({
    ...ride.toObject ? ride.toObject() : ride,
    passengers: passengerMap.get(ride._id.toString()) || [],
  }));

  return { meta, result: resultWithPassengers };
};

const getRiderRides = async (
  userId: string,
  query:  Record<string, unknown>,
) => {
  // ── Step 1: Ride status filter ────────────────────────────────────────────
  const rideStatusFilter: Record<string, any> = {};
  if (query.status) {
    rideStatusFilter.status = query.status;
  }

  // ── Step 2: Find passengers (non-cancelled/rejected/pending) ─────────────
  const passengerDocs = await Passenger.find({
    userId,
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
      ],
    },
  })
    .select('rideId pickup destination requestedSeats status estimatedFare departureDate departureTime')
    .lean();

  if (!passengerDocs.length)
    return { meta: { page: 1, limit: 10, total: 0, totalPage: 0 }, result: [] };

  const passengerIds = passengerDocs.map(p => p._id);
  const rideIds      = passengerDocs.map(p => p.rideId);

  // ── Step 3: Find rides with status filter ─────────────────────────────────
  const rides = await Ride.find({
    _id: { $in: rideIds },
    ...rideStatusFilter,
  })
    .populate([{ path: 'driverId', select: 'name profileImage phone email' }])
    .select('id type status driverId departureDate departureTime totalSeats bookedSeats malePassengers femalePassengers createdAt')
    .lean();

  const rideMap = new Map(rides.map(r => [r._id.toString(), r]));

  // ── Step 4: Find bookings for these passengers ────────────────────────────
  const bookings = await Booking.find({
    passengerId: { $in: passengerIds },
  })
    .select('id passengerId paymentStatus bookingStatus')
    .lean();

  // Booking lookup map by passengerId
  const bookingMap = new Map(
    bookings.map(b => [b.passengerId.toString(), b]),
  );

  // ── Step 5: Merge ─────────────────────────────────────────────────────────
  const result = passengerDocs
    .filter(p => rideMap.has(p.rideId.toString()))
    .map(p => {
      const ride    = rideMap.get(p.rideId.toString())!;
      const booking = bookingMap.get(p._id.toString());

      return {
        // Passenger
        userId,
        passengerId:     p._id,
        requestedSeats:  p.requestedSeats,
        estimatedFare:   p.estimatedFare,
        pickup:          p.pickup,
        destination:     p.destination,
        departureDate:   p.departureDate,
        departureTime:   p.departureTime,

        // Booking
        bookingId:       booking?._id     || null,
        bookingShortId:       booking?.id     || null,
        paymentStatus:   booking?.paymentStatus || null, 

        // Ride
        rideId:          ride._id,
        rideType:        ride.type,
        rideStatus:      ride.status,

        // Driver
        driver: ride.driverId || null,
      };
    });

  // ── Step 6: Pagination ────────────────────────────────────────────────────
  const page  = parseInt(String(query.page  || 1));
  const limit = parseInt(String(query.limit || 10));
  const skip  = (page - 1) * limit;
  const total = result.length;

  const paginated = result.slice(skip, skip + limit);

  return {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    result: paginated,
  };
};

const getRideById = async (rideId: string) => {
  const ride = await Ride.findById(rideId)
    .populate([
      { path: 'driverId', select: 'name email phone profileImage' },
      { path: 'vehicleId', select: 'name number year seats' },
      { path: 'rideCreatedBy', select: 'name email phone profileImage' },
    ])
    .select(
      'pickup destination departureDate departureTime bookedSeats status createdAt type driverId rideCreatedBy'
    )
    .lean();

  if (!ride) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  const passengers = await Passenger.find({ rideId })
    .populate('userId', 'name email phone profileImage')
    .lean();

  return {
    ...ride,
    passengers,
  };
};

export const RideService = {
  getAllIntoDB,
  getDriverRides,
  getRiderRides,
  getRideById,
};
