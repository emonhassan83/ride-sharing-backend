import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Passenger } from './passenger.model';
import { Ride } from '../ride/ride.model';
import { PASSENGER_STATUS } from './passenger.constant';
import { RIDE_STATUS } from '../ride/ride.constant';
import { Booking } from '../booking/booking.model';
import { getRedisClient } from '../../config/redis.config';
import { buildStoredFareBreakdown } from '../../utils/fareBreakdownResponse.utils';

const getDriverRideRequest = async (driverUserId: string) => {
  // Find rides where the user is a passenger and the ride is pending
  const pendingRides = await Ride.find({
    notifiedDriverIds: driverUserId,
    $or: [
      { status: RIDE_STATUS.pending },
      { status: RIDE_STATUS.accepted, driverId: driverUserId },
    ],
  })
    .select('_id')
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
      'userId rideId pickup destination departureDate departureTime requestedSeats estimatedDistanceKm estimatedFare status createdAt'
    )
    .sort({ createdAt: -1 })
    .lean();

  return passengerRides;
};

// Get all passengers for a ride
const getPassengersByRide = async (rideId: string) => {
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
      'userId pickup destination departureDate departureTime requestedSeats estimatedFare status createdAt'
    )
    .sort({ createdAt: -1 });

  if (!passengers.length) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'No passengers found for this ride'
    );
  }

  return passengers;
};

// Get single passenger by ID
const getPassengerById = async (passengerId: string) => {
  const passenger = await Passenger.findById(passengerId)
    .populate([
      { path: 'userId', select: 'name phone profileImage' },
      {
        path: 'rideId',
        select: 'departureDate departureTime pickup destination driverId type currentSurchargePercent',
        populate: [
          {
            path: 'driverId',
            select: 'name email phone profileImage',
          },
        ],
      },
    ])
    .lean();

  if (!passenger) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Passenger not found');
  }

  const booking = await Booking.findOne({ passengerId })
    .select('id paymentStatus bookingStatus totalFare amountPaid')
    .lean();

  const fareBreakdown = await buildStoredFareBreakdown(
    passenger,
    booking,
    (passenger as any).rideId,
  );

  return {
    ...passenger,
    baseFare: fareBreakdown.baseFare,
    vatPercentage: fareBreakdown.vatPercentage,
    vatAmount: fareBreakdown.vatAmount,
    vatIncluded: fareBreakdown.vatIncluded,
    platformCommissionPercentage: fareBreakdown.platformCommissionPercentage,
    platformCommission: fareBreakdown.platformCommissionAmount,
    platformCommissionAmount: fareBreakdown.platformCommissionAmount,
    fivePassengerExtraChargePercentage: fareBreakdown.fivePassengerExtraChargePercentage,
    fivePassengerExtraCharge: fareBreakdown.fivePassengerExtraCharge,
    sixPassengerExtraChargePercentage: fareBreakdown.sixPassengerExtraChargePercentage,
    sixPassengerExtraCharge: fareBreakdown.sixPassengerExtraCharge,
    bookingId: booking?._id || null,
    bookingShortId: booking?.id || null,
    fareBreakdown,
  };
};

export const PassengerService = {
  getDriverRideRequest,
  getPassengersByRide,
  getPassengerById,
};








