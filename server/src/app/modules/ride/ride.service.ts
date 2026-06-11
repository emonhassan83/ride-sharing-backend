import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { RIDE_STATUS } from './ride.constant';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS } from '../passenger/passenger.constant';

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
  query: Record<string, unknown>
) => {
  // ── Find rideIds where this user is a passenger ───────────────────────────
  const passengerRideIds = await Passenger.find({
    userId,
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
      ],
    },
  })
    .select('rideId')
    .lean();

  const rideIds = passengerRideIds.map((p) => p.rideId);
  if (!rideIds.length)
    return { meta: { page: 1, limit: 10, total: 0, totalPage: 0 }, result: [] };

  const rideQuery = new QueryBuilder(
    Ride.find({
      _id: { $in: rideIds },
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
