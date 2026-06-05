import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Booking } from './booking.model';
import { User } from '../user/user.model';
import { USER_ROLE } from '../user/user.constant';
import QueryBuilder from '../../builder/QueryBuilder';
import { PAYMENT_STATUS } from './booking.constant';

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
const getAllBookings = async (query: Record<string, unknown>) => {
  const bookingQuery = new QueryBuilder(
    Booking.find({ paymentStatus: { $ne: PAYMENT_STATUS.pending } }).populate([
      { path: 'userId', select: 'name ' },
      { path: 'driverId', select: 'name' },
      {
        path: 'passengerId',
        select: 'pickup destination departureDate departureTime requestedSeats',
      },
      {
        path: 'rideId',
        select: 'type vehicleId',
        populate: { path: 'vehicleId', select: 'name number seats year' },
      },
    ]),
    query
  )
    .search(['id'])
    .filter()
    .sort()
    .paginate()
    .fields();

  const bookings = await bookingQuery.modelQuery;
  const meta = await bookingQuery.countTotal();

  return { data: bookings, meta };
};

// ==================== USER & DRIVER ====================
const getMyBookings = async (userId: string, query: Record<string, unknown>) => {
  const user = await User.findById(userId).select('role isDeleted').lean()
  if (!user || user.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found')
  }

  const baseFilter =
    user.role === USER_ROLE.user
      ? { userId }
      : { driverId: userId }

  const bookingQuery = new QueryBuilder(
    Booking.find(baseFilter).populate([
      { path: 'userId',      select: 'name' },
      { path: 'driverId',    select: 'name' },
      {
        path:   'passengerId',
        select: 'pickup destination departureDate departureTime requestedSeats',
      },
      {
        path:     'rideId',
        select:   'type vehicleId',
        populate: { path: 'vehicleId', select: 'name number seats year' },
      },
    ]),
    query
  )
    .search(['id'])
    .filter()
    .sort()
    .paginate()
    .fields()

  const bookings = await bookingQuery.modelQuery
  const meta     = await bookingQuery.countTotal()

  return { data: bookings, meta }
}

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
