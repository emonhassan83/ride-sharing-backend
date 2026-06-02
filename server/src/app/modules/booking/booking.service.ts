import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Booking } from './booking.model';
import { User } from '../user/user.model';
import { USER_ROLE } from '../user/user.constant';

// ==================== COMMON ====================
const getBookingById = async (bookingId: string) => {
  const booking = await Booking.findById(bookingId)
    .populate('userId', 'name profileImage email phone')
    .populate('driverId', 'name profileImage email phone')
    .populate(
      'passengerId',
      'pickup destination fareType initialCharge perKmCharge departureTime estimatedDistanceKm totalKmCharge luggageCounts luggageCharge holidayTripCharge vat extraCharge estimatedFare departureDate departureTime'
    )
    .populate({
      path: 'rideId',
      select: 'type vehicleId',
      populate: {
        path: 'vehicleId',
        select: 'name number seats year',
      },
    });

  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'Booking not found');
  return booking;
};

// ==================== ADMIN ====================
const getAllBookings = async (filters: any = {}) => {
  const query: any = {};

  if (filters.bookingStatus) query.bookingStatus = filters.bookingStatus;
  if (filters.paymentStatus) query.paymentStatus = filters.paymentStatus;
  if (filters.tripStatus) query.tripStatus = filters.tripStatus;

  return Booking.find(query)
    .populate('userId', 'name')
    .populate('driverId', 'name')
    .populate(
      'passengerId',
      'pickup destination departureDate departureTime requestedSeats'
    )
    .sort({ createdAt: -1 });
};

// ==================== USER & DRIVER ====================
const getMyBookings = async (
  userId: string,
  filters: any = {}
) => {
  const query: any = {};

  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  if (user.role === USER_ROLE.user) query.userId = userId;
  else query.driverId = userId;

  if (filters.bookingStatus) query.bookingStatus = filters.bookingStatus;
  if (filters.tripStatus) query.tripStatus = filters.tripStatus;

  return Booking.find(query)
    .populate('userId', 'name')
    .populate('driverId', 'name')
    .populate(
      'passengerId',
      'pickup destination departureDate departureTime requestedSeats'
    )
    .sort({ createdAt: -1 });
};

// ==================== STATUS UPDATE ====================
const updateBookingStatus = async (bookingId: string, payload: any) => {
  const booking = await Booking.findById(bookingId);

  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'Booking not found');

  // Update fields
  if (payload.bookingStatus) booking.bookingStatus = payload.bookingStatus;

  await booking.save();
  return booking;
};

export const BookingService = {
  getAllBookings,
  getMyBookings,
  getBookingById,
  updateBookingStatus,
};
