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
import { calcSplitPassengerFare, computeSplitPoolKomistraBase, getSplitMaxMatchedRiders } from '../../../utils/splitFare.utils';
import { toRiderPriceView } from '../../../utils/riderPriceResponse.utils';
import {
  findEligibleExistingSplitRide,
  isRequestEligibleForSplitRide,
  requestToMatchCandidate,
} from '../../../utils/splitMatching.utils';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { assertMinimumBookingLeadTime, assertSplitMinimumDistance } from '../../../utils/rideSchedule.utils';
import { normalizeAndAssertLuggage } from '../../../utils/luggage.utils';

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
      largeSuitcase,
      smallSuitcase,
      luggageNote,
      note,
      rideId: requestedRideId,
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

    const luggage = normalizeAndAssertLuggage({
      largeSuitcase,
      smallSuitcase,
      luggageNote,
      requestedSeats,
    });

    const { departureDateTime } = await assertMinimumBookingLeadTime(
      departureDate,
      departureTime,
      RIDE_TYPE.split
    );

    const matchRequest = requestToMatchCandidate({
      pickup: { lat: pickup.lat, lng: pickup.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      departureDate,
      departureTime,
    });

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

    await assertSplitMinimumDistance(actualDistance);

    const fareType = getFareType(departureDateTime);
    const redis = getRedisClient();
    let selectedRide: any = null;
    let activeSeatsBeforeJoin = 0;
    let activeRidersBeforeJoin = 0;

    // Manual select: join a specific ride from "Find your Split Ride".
    if (requestedRideId) {
      const targetRide = await Ride.findOne({
        _id: requestedRideId,
        type: RIDE_TYPE.split,
        splitFareLocked: { $ne: true },
        status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
      }).lean();

      if (!targetRide) {
        return callback?.({
          success: false,
          message: 'Selected split ride was not found or is no longer available.',
        });
      }

      const eligibility = await isRequestEligibleForSplitRide(matchRequest, targetRide, {
        requirePaidBooking: true,
        requestedSeats,
      });

      if (!eligibility.ok) {
        return callback?.({
          success: false,
          message:
            'Selected split ride does not meet matching rules (pickup/destination radius, time window, seats, or capacity).',
          data: { reason: eligibility.reason },
        });
      }

      const alreadyJoined = await Passenger.findOne({
        rideId: targetRide._id,
        userId,
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      }).lean();
      if (alreadyJoined) {
        return callback?.({
          success: false,
          message: 'You already have an active request on this split ride.',
        });
      }

      selectedRide = targetRide;
      activeSeatsBeforeJoin = eligibility.usedSeats;
      activeRidersBeforeJoin = eligibility.activePassengers.length;
    } else {
      const nearbySplitRides = await Ride.find({
        type: RIDE_TYPE.split,
        splitFareLocked: { $ne: true },
        status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
        departureDate,
        $or: [
          { totalSeats: 0 },
          { $expr: { $gte: [{ $subtract: ['$totalSeats', '$bookedSeats'] }, requestedSeats] } },
        ],
      })
        .sort({ driverId: -1, createdAt: 1 })
        .lean();

      const auto = await findEligibleExistingSplitRide(matchRequest, nearbySplitRides, {
        requirePaidBooking: true,
        requestedSeats,
        userId,
      });

      if (auto) {
        selectedRide = auto.ride;
        activeSeatsBeforeJoin = auto.usedSeats;
        activeRidersBeforeJoin = auto.activePassengers.length;
      }
    }

    if (!selectedRide) {
      const fareBreakdown = await calcSplitPassengerFare(
        actualDistance,
        requestedSeats,
        1,
        0, // luggage FYI only — never billed
        departureTime,
        departureDateTime
      );

      const passenger = await Passenger.create({
        userId,
        rideId: null,
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
        luggageCharge: 0,
        holidayTripCharge: fareBreakdown.holidayTripCharge,
        vat: fareBreakdown.vatAmount,
        surchargePercent: fareBreakdown.surchargePercent,
        surchargeAmount: fareBreakdown.surchargeAmount,
        estimatedFare: fareBreakdown.estimatedFare,
        totalFare: fareBreakdown.estimatedFare,
        waitingCharge: 0,
        estimatedDistanceKm: actualDistance,
        estimatedDurationMinutes: actualDuration,
        luggageCounts: 0,
        largeSuitcase: luggage.largeSuitcase,
        smallSuitcase: luggage.smallSuitcase,
        luggageNote: luggage.luggageNote,
        note: note ?? '',
        status: PASSENGER_STATUS.split_matching,
        originalRideIntent: 'split',
      });

      const booking = await Booking.create({
        passengerId: passenger._id,
        rideId: null,
        userId,
        driverId: null,
        totalFare: passenger.estimatedFare,
        amountPaid: 0,
        bookingStatus: BOOKING_STATUS.pending,
        paymentStatus: BOOKING_PAYMENT_STATUS.pending,
      });

      socket.join(`passenger:${passenger._id}`);

      const ttl = Math.max(
        3600,
        Math.floor((departureDateTime.getTime() - Date.now()) / 1000) + 7200
      );
      await redis.hset(`split:matching:passenger:${passenger._id}`, {
        userId,
        passengerId: passenger._id.toString(),
        bookingId: booking._id.toString(),
        estimatedFare: fareBreakdown.estimatedFare.toString(),
        matchingStatus: 'awaiting_payment',
        timestamp: Date.now().toString(),
      });
      await redis.expire(`split:matching:passenger:${passenger._id}`, ttl);

      const price = toRiderPriceView({
        estimatedFare: fareBreakdown.estimatedFare,
        vatAmount: fareBreakdown.vatAmount,
        vatPercentage: fareBreakdown.platformVatPercent,
      });

      const requestedRide = {
        rideId: null,
        passengerId: passenger._id.toString(),
        bookingId: booking._id.toString(),
        matchingStatus: PASSENGER_STATUS.split_matching,
        ...price,
        availableSeats: 0,
        departureDate,
        departureTime,
        pickup: { address: pickup.address },
        destination: { address: destination.address },
      };

      return callback?.({
        success: true,
        message:
          'No matching split ride found yet. Complete payment; we will keep matching peers until the 1h Solo fallback.',
        data: {
          rideId: null,
          passengerId: passenger._id.toString(),
          bookingId: booking._id.toString(),
          matchingStatus: PASSENGER_STATUS.split_matching,
          requestedRide,
          requestedRides: [requestedRide],
          estimatedDistance: roundTo2(actualDistance),
          estimatedDuration: actualDuration,
          luggage: {
            largeSuitcase: luggage.largeSuitcase,
            smallSuitcase: luggage.smallSuitcase,
            luggageNote: luggage.luggageNote,
            luggageCounts: 0,
            ...luggage.sizeGuide,
          },
        },
      });
    }

    const activeRidersAfterJoin = activeRidersBeforeJoin + 1;
    const maxMatchedRiders = await getSplitMaxMatchedRiders();
    if (activeRidersAfterJoin > maxMatchedRiders) {
      return callback?.({
        success: false,
        message: `Split ride allows a maximum of ${maxMatchedRiders} matched riders.`,
      });
    }

    let poolKomistraBase: number | undefined;
    if (activeRidersAfterJoin >= 2) {
      const existingActivePassengers = await Passenger.find({
        rideId: selectedRide._id,
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      })
        .select('estimatedDistanceKm requestedSeats luggageCounts')
        .lean();

      poolKomistraBase = await computeSplitPoolKomistraBase({
        departureTime,
        departureDate: departureDateTime,
        passengers: [
          ...existingActivePassengers.map((passenger: any) => ({
            estimatedDistanceKm: passenger.estimatedDistanceKm || 0,
            requestedSeats: passenger.requestedSeats || 1,
            luggageCounts: 0,
          })),
          {
            estimatedDistanceKm: actualDistance,
            requestedSeats,
            luggageCounts: 0,
          },
        ],
      });
    }

    const fareBreakdown = await calcSplitPassengerFare(
      actualDistance,
      requestedSeats,
      activeRidersAfterJoin,
      0, // luggage FYI only — never billed
      departureTime,
      departureDateTime,
      poolKomistraBase !== undefined ? { poolKomistraBase } : {},
    );

    const passenger = await Passenger.create({
      userId,
      rideId: selectedRide._id,
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
      luggageCharge: 0,
      holidayTripCharge: fareBreakdown.holidayTripCharge,
      vat: fareBreakdown.vatAmount,
      surchargePercent: fareBreakdown.surchargePercent,
      surchargeAmount: fareBreakdown.surchargeAmount,
      estimatedFare: fareBreakdown.estimatedFare,
      totalFare: fareBreakdown.estimatedFare,
      waitingCharge: 0,
      estimatedDistanceKm: actualDistance,
      estimatedDurationMinutes: actualDuration,
      luggageCounts: 0,
      largeSuitcase: luggage.largeSuitcase,
      smallSuitcase: luggage.smallSuitcase,
      luggageNote: luggage.luggageNote,
      note: note ?? '',
      status: PASSENGER_STATUS.pending,
      originalRideIntent: 'split',
      matchedVia: 'manual_join',
      matchedAt: new Date(),
    });

    const booking = await Booking.create({
      passengerId: passenger._id,
      rideId: selectedRide._id,
      userId,
      driverId: (selectedRide as any).driverId || undefined,
      totalFare: passenger.estimatedFare,
      amountPaid: 0,
      bookingStatus: BOOKING_STATUS.pending,
      paymentStatus: BOOKING_PAYMENT_STATUS.pending,
    });

    socket.join(`ride:${selectedRide._id}`);
    socket.join(`passenger:${passenger._id}`);

    const ttl = Math.max(
      3600,
      Math.floor((departureDateTime.getTime() - Date.now()) / 1000) + 7200
    );
    await redis.hset(`ride:request:${selectedRide._id}:${passenger._id}`, {
      userId,
      passengerId: passenger._id.toString(),
      rideId: selectedRide._id.toString(),
      bookingId: booking._id.toString(),
      estimatedFare: fareBreakdown.estimatedFare.toString(),
      matchingStatus: 'awaiting_payment',
      timestamp: Date.now().toString(),
    });
    await redis.expire(`ride:request:${selectedRide._id}:${passenger._id}`, ttl);

    const price = toRiderPriceView({
      estimatedFare: fareBreakdown.estimatedFare,
      vatAmount: fareBreakdown.vatAmount,
      vatPercentage: fareBreakdown.platformVatPercent,
    });

    const requestedRide = {
      rideId: selectedRide._id.toString(),
      passengerId: passenger._id.toString(),
      bookingId: booking._id.toString(),
      ...price,
      availableSeats: selectedRide.totalSeats
        ? selectedRide.totalSeats - activeSeatsBeforeJoin - requestedSeats
        : 0,
      departureDate: selectedRide.departureDate,
      departureTime: selectedRide.departureTime,
      pickup: { address: (selectedRide as any).pickup.address },
      destination: { address: (selectedRide as any).destination.address },
    };

    return callback?.({
      success: true,
      message: requestedRideId
        ? 'Joined selected split ride. Please complete payment to notify driver.'
        : 'Split ride join request created for existing ride. Please complete payment to notify driver.',
      data: {
        rideId: requestedRide.rideId,
        passengerId: requestedRide.passengerId,
        bookingId: requestedRide.bookingId,
        matchedVia: 'manual_join',
        requestedRide,
        requestedRides: [requestedRide],
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        luggage: {
          largeSuitcase: luggage.largeSuitcase,
          smallSuitcase: luggage.smallSuitcase,
          luggageNote: luggage.luggageNote,
          luggageCounts: 0,
          ...luggage.sizeGuide,
        },
      },
    });
  }
);
