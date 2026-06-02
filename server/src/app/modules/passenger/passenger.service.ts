import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Passenger } from './passenger.model';
import { Ride } from '../ride/ride.model';

const createPassenger = async (userId: string, payload: any) => {
  // 1️⃣ Check if ride exists
  const ride = await Ride.findById(payload.rideId);
  if (!ride) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  // 2️⃣ Check if requested seats are available
  if (payload.requestedSeats > (ride.totalSeats - ride.bookedSeats)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Not enough seats available');
  }

  // 3️⃣ Create passenger record
  const passenger = await Passenger.create({
    ...payload,
    userId
  });

  // 4️⃣ Update ride bookedSeats
  ride.bookedSeats += payload.requestedSeats;
  await ride.save();

  return passenger;
};

// Get all passengers for a ride
const getPassengersByRide = async (rideId: string) => {
  const passengers = await Passenger.find({ rideId })
    .populate('userId', 'name phone profileImage')
    .sort({ createdAt: -1 });

  if (!passengers.length) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'No passengers found for this ride');
  }

  return passengers;
};

// Get single passenger by ID
const getPassengerById = async (passengerId: string) => {
  const passenger = await Passenger.findById(passengerId)
    .populate('userId', 'name phone profileImage')
    .populate('rideId', 'departureDate departureTime pickup destination');

  if (!passenger) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Passenger not found');
  }

  return passenger;
};

export const PassengerService = {
  createPassenger,
  getPassengersByRide,
  getPassengerById,
};
