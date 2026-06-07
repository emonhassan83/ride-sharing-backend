import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';

const getAllIntoDB = async (
  driverId: string,
  filters: any = {}
) => {
  const query: any = {
    driverId,
    status: 'pending',
  };

  if (filters.rideType) query.rideType = filters.rideType;

  return Ride.find(query)
    .populate('userId', 'name phone profileImage avgRating')
    .sort({ createdAt: -1 });
};

const getMyRideRequests = async (userId: string, status?: string) => {
  const query: any = { userId };

  if (status) {
    query.status = status;
  }

  return Ride.find(query)
    .populate('driverId', 'name phone profileImage avgRating')
    .populate('vehicleId', 'name number year')
    .sort({ createdAt: -1 });
};

const getRideById = async (rideId: string) => {
  const ride = await Ride.findById(rideId)
    .populate('userId', 'name phone')
    .populate('driverId', 'name phone profileImage')
    .populate('vehicleId');

  if (!ride) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  return ride;
};

export const RideService = {
  getMyRideRequests,
  getAllIntoDB,
  getRideById,
};
