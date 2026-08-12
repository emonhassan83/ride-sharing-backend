// handlers/ride/splitRideRequest.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Booking } from '../../../modules/booking/booking.model';
import { BOOKING_STATUS, PAYMENT_STATUS as BOOKING_PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { calculateDistance } from '../../../utils/location.utils';
import { getFareType } from '../../../utils/time.utils';
import { roundTo2 } from '../../../utils/number.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { calcSplitPassengerFare } from '../../../utils/splitFare.utils';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { haversineMeters, isPointNearRoute } from '../../../utils/geo.utils';
import { assertMinimumBookingLeadTime } from '../../../utils/rideSchedule.utils';

export const joinSplitRideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup,
      destination,
      passengers,
      malePassengers,
      femalePassengers,
      departureDate,
      departureTime,
      luggageCounts,
      note,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId) return callback?.({ success: false, message: 'Unauthorized' });
    if (!pickup || !destination)
      return callback?.({ success: false, message: 'Pickup and destination are required' });
    if (!departureDate || !departureTime)
      return callback?.({ success: false, message: 'departureDate and departureTime are required' });

    const requestedSeats = Number(passengers) > 0 ? Number(passengers) : 1;
    const malePassengerCount = Number(malePassengers) > 0 ? Number(malePassengers) : 0;
    const femalePassengerCount = Number(femalePassengers) > 0 ? Number(femalePassengers) : 0;
    const { departureDateTime } = await assertMinimumBookingLeadTime(
      departureDate,
      departureTime,
      RIDE_TYPE.split
    );

    const nearbySplitRides = await Ride.find({
      type: RIDE_TYPE.split,
      splitFareLocked: { $ne: true },
      status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
      departureDate,
      $or: [
        { totalSeats: 0 },
        { $expr: { $gte: [{ $subtract: ['$totalSeats', '$bookedSeats'] }, requestedSeats] } },
      ],
    }).lean();

    const matchingRides = nearbySplitRides.filter((ride) => {
      if ((ride as any).splitFareLocked) return false;
      const coords = (ride as any).routeGeometry?.coordinates;
      if (!coords?.length) return false;

      if (!isPointNearRoute(pickup.lat, pickup.lng, coords)) return false;
      if (!isPointNearRoute(destination.lat, destination.lng, coords)) return false;

      let pickupIdx = -1;
      let destIdx = -1;
      let pickupDist = Infinity;
      let destDist = Infinity;

      coords.forEach(([lng, lat]: [number, number], index: number) => {
        const pd = haversineMeters(pickup.lat, pickup.lng, lat, lng);
        const dd = haversineMeters(destination.lat, destination.lng, lat, lng);
        if (pd < pickupDist) {
          pickupDist = pd;
          pickupIdx = index;
        }
        if (dd < destDist) {
          destDist = dd;
          destIdx = index;
        }
      });

      return destIdx > pickupIdx;
    });

    if (!matchingRides.length)
      return callback?.({ success: false, message: 'No nearby split rides found for your route.' });

    let actualDistance = 0;
    let actualDuration = 0;
    try {
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng }
      );
      actualDistance = distanceKm;
      actualDuration = durationMinutes;
    } catch {
      actualDistance = calculateDistance(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng }
      );
      actualDuration = Math.ceil((actualDistance / 30) * 60);
    }

    const fareType = getFareType(departureDateTime);
    const redis = getRedisClient();
    const passengerList: any[] = [];
    const requestedRides: any[] = [];

    for (const ride of matchingRides) {
      const alreadyJoined = await Passenger.findOne({
        rideId: ride._id,
        userId,
        status: { $nin: [PASSENGER_STATUS.cancelled] },
      });
      if (alreadyJoined) continue;

      const totalSeatsAfterJoin = (ride.bookedSeats || 0) + requestedSeats;
      const fareBreakdown = await calcSplitPassengerFare(
        actualDistance,
        requestedSeats,
        totalSeatsAfterJoin,
        luggageCounts || 0,
        departureTime,
        departureDateTime
      );

      const passenger = await Passenger.create({
        userId,
        rideId: ride._id,
        pickup: { address: pickup.address, coordinates: [pickup.lng, pickup.lat] },
        destination: { address: destination.address, coordinates: [destination.lng, destination.lat] },
        departureDate,
        departureTime,
        requestedSeats,
        malePassengers: malePassengerCount,
        femalePassengers: femalePassengerCount,
        fareType,
        initialCharge: fareBreakdown.initialCharge,
        perKmCharge: fareBreakdown.totalKmCharge / (actualDistance || 1),
        totalKmCharge: fareBreakdown.totalKmCharge,
        luggageCharge: fareBreakdown.luggageCharge,
        holidayTripCharge: fareBreakdown.holidayTripCharge,
        surchargePercent: fareBreakdown.surchargePercent,
        surchargeAmount: fareBreakdown.surchargeAmount,
        estimatedFare: fareBreakdown.estimatedFare,
        totalFare: fareBreakdown.estimatedFare,
        waitingCharge: 0,
        estimatedDistanceKm: actualDistance,
        estimatedDurationMinutes: actualDuration,
        luggageCounts: luggageCounts || 0,
        note: note ?? '',
        status: PASSENGER_STATUS.pending,
      });

      const booking = await Booking.create({
        passengerId: passenger._id,
        rideId: ride._id,
        userId,
        driverId: (ride as any).driverId || undefined,
        totalFare: passenger.estimatedFare,
        amountPaid: 0,
        bookingStatus: BOOKING_STATUS.pending,
        paymentStatus: BOOKING_PAYMENT_STATUS.pending,
      });

      passengerList.push(passenger);
      socket.join(`ride:${ride._id}`);
      socket.join(`passenger:${passenger._id}`);

      const ttl = Math.max(
        3600,
        Math.floor((departureDateTime.getTime() - Date.now()) / 1000) + 7200
      );
      await redis.hset(`ride:request:${ride._id}:${passenger._id}`, {
        userId,
        passengerId: passenger._id.toString(),
        rideId: ride._id.toString(),
        bookingId: booking._id.toString(),
        estimatedFare: fareBreakdown.estimatedFare.toString(),
        matchingStatus: 'awaiting_payment',
        timestamp: Date.now().toString(),
      });
      await redis.expire(`ride:request:${ride._id}:${passenger._id}`, ttl);

      requestedRides.push({
        rideId: ride._id.toString(),
        passengerId: passenger._id.toString(),
        bookingId: booking._id.toString(),
        estimatedFare: fareBreakdown.estimatedFare,
        surchargePercent: fareBreakdown.surchargePercent,
        surchargeAmount: fareBreakdown.surchargeAmount,
        minimumFareApplied: fareBreakdown.minimumFareApplied,
        minimumFareAmount: fareBreakdown.minimumFareAmount,
        minimumFareAdjustment: fareBreakdown.minimumFareAdjustment,
        splitSurchargePercent: fareBreakdown.splitSurchargePercent,
        splitSurchargeAmount: fareBreakdown.splitSurchargeAmount,
        availableSeats: ride.totalSeats ? ride.totalSeats - (ride.bookedSeats || 0) - requestedSeats : 0,
        departureDate: ride.departureDate,
        departureTime: ride.departureTime,
        pickup: { address: (ride as any).pickup.address },
        destination: { address: (ride as any).destination.address },
      });
    }

    if (!passengerList.length)
      return callback?.({ success: false, message: 'You have already joined all nearby split rides.' });

    return callback?.({
      success: true,
      message: `Split ride join request created for ${requestedRides.length} ride(s). Please complete payment to notify drivers.`,
      data: {
        requestedRides,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
      },
    });
  }
);
