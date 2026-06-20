import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { RIDE_STATUS } from './ride.constant';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS } from '../passenger/passenger.constant';
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
  const rideQuery = new QueryBuilder(
    Ride.find({
      driverId: userId,
      status: {
        $nin: [
          RIDE_STATUS.pending,
          RIDE_STATUS.cancelled,
          RIDE_STATUS.rejected,
        ],
      },
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

  return { meta, result };
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
    .populate([{ path: 'driverId', select: 'name' }])
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
        passengerId:     p._id,
        requestedSeats:  p.requestedSeats,
        estimatedFare:   p.estimatedFare,
        pickup:          p.pickup,
        destination:     p.destination,
        departureDate:   p.departureDate,
        departureTime:   p.departureTime,

        // Booking
        bookingId:       booking?.id     || null,
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
