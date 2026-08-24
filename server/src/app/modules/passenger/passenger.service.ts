import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Passenger } from './passenger.model';
import { Ride } from '../ride/ride.model';
import { PASSENGER_STATUS } from './passenger.constant';
import { RIDE_STATUS } from '../ride/ride.constant';
import { Booking } from '../booking/booking.model';
import { getRedisClient } from '../../config/redis.config';
import { Setting } from '../settings/settings.model';

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
        select: 'departureDate departureTime pickup destination driverId',
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

  const settings = await Setting.find({
    key: {
      $in: [
        'platformVat',
        'platformCommissionPercent',
        'baseFare',
        'fivePassengerExtraChargePercentage',
        'sixPassengerExtraChargePercentage',
      ],
    },
  }).lean();
  const settingMap = new Map(settings.map((setting: any) => [setting.key, Number(setting.value)]));
  const vatPercentage = settingMap.get('platformVat') ?? 0;
  const platformCommissionPercentage = settingMap.get('platformCommissionPercent') ?? 0;
  const baseFare = settingMap.get('baseFare') ?? 0;
  const fivePassengerExtraChargePercentage = settingMap.get('fivePassengerExtraChargePercentage') ?? 0;
  const sixPassengerExtraChargePercentage = settingMap.get('sixPassengerExtraChargePercentage') ?? 0;

  const grossFare = Number((passenger as any).totalFare || (passenger as any).estimatedFare || booking?.totalFare || 0);
  const fareBeforeFees = Math.round((grossFare / (1 + (vatPercentage + platformCommissionPercentage) / 100)) * 100) / 100;
  const platformCommissionAmount = Math.round((fareBeforeFees * (platformCommissionPercentage / 100)) * 100) / 100;

  return {
    ...passenger,
    baseFare,
    vatPercentage,
    vatAmount: (passenger as any).vat ?? 0,
    platformCommissionPercentage,
    platformCommission: platformCommissionAmount,
    platformCommissionAmount,
    fivePassengerExtraChargePercentage,
    fivePassengerExtraCharge: (passenger as any).fivePassengerCharge ?? 0,
    sixPassengerExtraChargePercentage,
    sixPassengerExtraCharge: (passenger as any).sixPassengerCharge ?? 0,
    bookingId: booking?._id || null,
    bookingShortId: booking?.id || null,
  };
};

export const PassengerService = {
  getDriverRideRequest,
  getPassengersByRide,
  getPassengerById,
};







