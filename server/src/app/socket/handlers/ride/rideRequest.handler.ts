// handlers/ride/rideRequest.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { User } from '../../../modules/user/user.model';
import { calculateDistance } from '../../../utils/location.utils';
import { calculateFareBreakdown } from '../../../utils/fareCalculator';
import { getFareType } from '../../../utils/time.utils';
import { roundObjectNumbers, roundTo2 } from '../../../utils/number.utils';
import { getRealDistanceAndETA, getRouteGeometry } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { notifyNearbyDrivers } from '../../../utils/notifyDrivers.utils';
import { Booking } from '../../../modules/booking/booking.model';
import { BOOKING_STATUS, PAYMENT_STATUS as BOOKING_PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { assertMinimumBookingLeadTime } from '../../../utils/rideSchedule.utils';

export const rideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup, destination, type, passengers,
      malePassengers, femalePassengers,
      departureDate, departureTime,
      luggageCounts, note,
      selectedDriverId, driverId,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId || !pickup || !destination || !type)
      return callback?.({ success: false, message: 'Missing required fields' });

    if (!departureDate || !departureTime)
      return callback?.({ success: false, message: 'departureDate and departureTime are required' });

    const requestedSeats = Number(passengers) > 0 ? Number(passengers) : 1;
    const malePassengerCount = Number(malePassengers) > 0 ? Number(malePassengers) : 0;
    const femalePassengerCount = Number(femalePassengers) > 0 ? Number(femalePassengers) : 0;

    const { departureDateTime } = await assertMinimumBookingLeadTime(
      departureDate,
      departureTime,
      type
    );

    const redis = getRedisClient();
    const io    = getIO();

    const requestedDriverId = selectedDriverId || driverId;
    const notifyMode = 'all_eligible';

    // â”€â”€ Real distance & ETA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let actualDistance = 0;
    let actualDuration = 0;
    try {
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        { lat: pickup.lat,      lng: pickup.lng      },
        { lat: destination.lat, lng: destination.lng },
      );
      actualDistance = distanceKm;
      actualDuration = durationMinutes;
    } catch {
      actualDistance = calculateDistance(
        { lat: pickup.lat,      lng: pickup.lng      },
        { lat: destination.lat, lng: destination.lng },
      );
      actualDuration = Math.ceil((actualDistance / 30) * 60);
    }

    // â”€â”€ Route geometry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let routeGeometry = {};
    try { routeGeometry = await getRouteGeometry(pickup, destination); } catch { /* ignore */ }

    // â”€â”€ Fare breakdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const fareBreakdown = await calculateFareBreakdown({
      distanceKm:     actualDistance,
      departureDate:  departureDateTime,
      departureTime:  departureTime,
      luggageCount:   luggageCounts || 0,
      requestedSeats,
      rideType:       type,
      waitingMinutes: 0,
    });
    const roundedBreakdown = roundObjectNumbers(fareBreakdown);
    const fareType         = getFareType(departureDateTime);

    // â”€â”€ Determine totalSeats from vehicle for split rides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // let totalSeats = requestedSeats;
    // if (type === RIDE_TYPE.split) {
    //   const vehicle = await Vehicle.findOne({
    //     userId,
    //     isDefault: true,
    //     isDeleted: false,
    //   }).select('seats').lean();
    //   totalSeats = vehicle?.seats || requestedSeats;
    // }

    // â”€â”€ Create Ride â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ride = await Ride.create({
      type,
      rideCreatedBy: userId,
      pickup:        { address: pickup.address,      coordinates: [pickup.lng, pickup.lat] },
      destination:   { address: destination.address, coordinates: [destination.lng, destination.lat] },
      departureDate: departureDate,
      departureTime: departureTime,
      totalSeats:    0,
      bookedSeats:   0,
      status:        RIDE_STATUS.pending,
      routeGeometry,
    });

    // â”€â”€ Create Passenger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const passenger = await Passenger.create({
      userId,
      rideId:                   ride._id,
      pickup:                   { address: pickup.address,      coordinates: [pickup.lng, pickup.lat] },
      destination:              { address: destination.address, coordinates: [destination.lng, destination.lat] },
      departureDate:            departureDate,
      departureTime:            departureTime,
      requestedSeats,
      malePassengers:           malePassengerCount,
      femalePassengers:         femalePassengerCount,
      fareType,
      initialCharge:            fareBreakdown.initialCharge,
      perKmCharge:              fareBreakdown.perKmCharge,
      totalKmCharge:            roundTo2(fareBreakdown.totalKmCharge),
      luggageCharge:            fareBreakdown.luggageCharge,
      holidayTripCharge:        fareBreakdown.holidaySurcharge,
      surchargePercent:         fareBreakdown.splitSurchargePercent || 0,
      surchargeAmount:          fareBreakdown.splitSurchargeAmount || 0,
      vat:                      fareBreakdown.vat,
      estimatedFare:            roundTo2(fareBreakdown.totalFare),
      totalFare:                roundTo2(fareBreakdown.totalFare),
      waitingCharge:            fareBreakdown.waitingCharge || 0,
      fivePassengerCharge:      requestedSeats === 5 ? fareBreakdown.passengerCountExtra || 0 : 0,
      sixPassengerCharge:       requestedSeats === 6 ? fareBreakdown.passengerCountExtra || 0 : 0,
      estimatedDistanceKm:      actualDistance,
      estimatedDurationMinutes: actualDuration,
      luggageCounts:            luggageCounts || 0,
      note:                     note ?? '',
      status:                   PASSENGER_STATUS.pending,
    });

    socket.join(`ride:${ride._id}`);
    socket.join(`passenger:${passenger._id}`);

    const rider = await User.findById(userId)
      .select('name profileImage avgRating phone')
      .lean();

    const ridePayload = {
      _id:  passenger._id,
      userId: {
        _id:          rider?._id          || null,
        name:         rider?.name         || '',
        profileImage: rider?.profileImage || null,
      },
      rideId: {
        _id:  ride._id,
        type: ride.type,
        id:   (ride as any).id || '',
      },
      pickup: {
        address:     pickup.address,
        coordinates: [pickup.lng, pickup.lat],
      },
      destination: {
        address:     destination.address,
        coordinates: [destination.lng, destination.lat],
      },
      departureDate:       departureDate,
      departureTime:       departureTime,
      rideType:            type,
      requestedSeats,
      estimatedFare:       roundTo2(fareBreakdown.totalFare),
      bookingId:           '',
      estimatedDistanceKm: roundTo2(actualDistance),
      status:              PASSENGER_STATUS.pending,
      createdAt:           passenger.createdAt,
    };

    // â”€â”€ Notify drivers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const booking = await Booking.create({
      passengerId: passenger._id,
      rideId: ride._id,
      userId,
      totalFare: passenger.estimatedFare,
      amountPaid: 0,
      bookingStatus: BOOKING_STATUS.pending,
      paymentStatus: BOOKING_PAYMENT_STATUS.pending,
    });

    ridePayload.bookingId = booking._id.toString();

    const notifiedCount = 0;

    // â”€â”€ Redis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await redis.hset(`ride:request:${ride._id}`, {
      userId,
      passengerId:        passenger._id.toString(),
      bookingId:          booking._id.toString(),
      pickup:             JSON.stringify(pickup),
      destination:        JSON.stringify(destination),
      seats:              requestedSeats.toString(),
      estimatedFare:      fareBreakdown.totalFare.toString(),
      departureDate,
      departureTime,
      departureTimestamp: departureDateTime.getTime().toString(),
      notifiedCount:      notifiedCount.toString(),
      lastNotifiedAt:     notifiedCount > 0 ? Date.now().toString() : '',
      selectedDriverId:   requestedDriverId ? requestedDriverId.toString() : '',
      matchingStatus:     'awaiting_payment',
      timestamp:          Date.now().toString(),
    });

    const ttlSeconds = Math.max(
      3600,
      Math.floor((departureDateTime.getTime() - Date.now()) / 1000) + 7200,
    );
    await redis.expire(`ride:request:${ride._id}`, ttlSeconds);
    // Matching starts only after payment authorization succeeds.

    return callback?.({
      success: true,
      message: notifiedCount > 0
        ? `Ride request created. ${notifiedCount} nearby driver(s) notified.`
        : 'Ride request created. We will keep looking for a driver.',
      data: {
        rideId:            ride._id.toString(),
        passengerId:       passenger._id.toString(),
        bookingId:          booking._id.toString(),
        notifiedDrivers:   notifiedCount,
        matchingStatus:     'awaiting_payment',
        estimatedFare:     roundedBreakdown.totalFare,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        fareBreakdown:     roundedBreakdown,
        rideDetails: {
          bookingDate: departureDate,
          bookingTime: departureTime,
          pickup:      passenger.pickup,
          destination: passenger.destination,
          rideType:    ride.type,
          totalSeats:  ride.totalSeats,
          bookingId:   booking._id.toString(),
        },
      },
    });
  },
);







