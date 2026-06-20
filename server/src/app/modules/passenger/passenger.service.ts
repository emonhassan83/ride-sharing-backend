import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Passenger } from './passenger.model';
import { Ride } from '../ride/ride.model';
import { PASSENGER_STATUS } from './passenger.constant';
import { RIDE_STATUS } from '../ride/ride.constant';
import { Booking } from '../booking/booking.model';

const getDriverRideRequest = async (driverUserId: string) => {
  // Find rides where the user is a passenger and the ride is pending
  const pendingRides = await Ride.find({
    notifiedDriverIds: driverUserId,
    status: [RIDE_STATUS.pending, RIDE_STATUS.accepted],
  })
    .select('_id')
    .lean();

  if (!pendingRides.length) return [];

  const rideIds = pendingRides.map((ride) => ride._id);
  const passengerRides = await Passenger.find({
    rideId: { $in: rideIds },
    status: PASSENGER_STATUS.pending,
  })
    .populate([
      {
        path: 'rideId',
        select: 'type',
      },
      {
        path: 'userId',
        select: 'name profileImage',
      },
    ])
    .select(
      'userId rideId pickup destination departureDate departureTime requestedSeats estimatedFare status createdAt'
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
    .populate('userId', 'name phone profileImage')
    .populate('rideId', 'departureDate departureTime pickup destination')
    .lean();

  if (!passenger) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Passenger not found');
  }

  const booking = await Booking.findOne({ passengerId })
    .select('id paymentStatus bookingStatus totalFare amountPaid')
    .lean();

  return {
    ...passenger,
    bookingId: booking?._id || null,
  };
};

export const PassengerService = {
  getDriverRideRequest,
  getPassengersByRide,
  getPassengerById,
};
