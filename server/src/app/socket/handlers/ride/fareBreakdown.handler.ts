// handlers/ride/fareBreakdown.handler.ts
import { calculateDistance } from '../../../utils/location.utils';
import { calculateFareBreakdown } from '../../../utils/fareCalculator';
import { roundObjectNumbers, roundTo2 } from '../../../utils/number.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { assertMinimumBookingLeadTime } from '../../../utils/rideSchedule.utils';

export const fareBreakdownHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup,
      destination,
      type,
      passengers,
      malePassengers,
      femalePassengers,
      departureDate,
      departureTime,
      luggageCounts,
    } = data;

    if (!pickup || !destination)
      return callback?.({ success: false, message: 'Pickup and destination are required' });

    if (!type)
      return callback?.({ success: false, message: 'Ride type is required' });

    const requestedSeats = passengers || 1;

    // ── Departure datetime ────────────────────────────────────────────────────
    let departureDateTime = new Date();
    if (departureDate && departureTime) {
      ({ departureDateTime } = await assertMinimumBookingLeadTime(
        departureDate,
        departureTime
      ));
    }

    // ── Real distance & ETA (Google Maps) ─────────────────────────────────────
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
      console.warn('⚠️ Google Maps failed — using Haversine fallback');
    }

    // ── Fare breakdown ────────────────────────────────────────────────────────
    const fareBreakdown = await calculateFareBreakdown({
      distanceKm:     actualDistance,
      departureDate:  departureDateTime,
      departureTime:  departureTime || new Date().toLocaleTimeString(),
      luggageCount:   luggageCounts || 0,
      requestedSeats,
      rideType:       type,
      waitingMinutes: 0,
    });

    const roundedBreakdown = roundObjectNumbers(fareBreakdown);

    return callback?.({
      success: true,
      message: 'Fare breakdown calculated successfully.',
      data: {
        estimatedFare:     roundedBreakdown.totalFare,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        fareBreakdown:     roundedBreakdown,
        rideDetails: {
          bookingDate:      departureDate  || new Date().toISOString().split('T')[0],
          bookingTime:      departureTime  || new Date().toLocaleTimeString(),
          pickup,
          destination,
          rideType:         type,
          requestedSeats,
          malePassengers:   malePassengers   || 0,
          femalePassengers: femalePassengers || 0,
          luggageCounts:    luggageCounts   || 0
        },
      },
    });
  },
);