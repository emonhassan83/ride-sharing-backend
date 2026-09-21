// handlers/ride/fareBreakdown.handler.ts
import { calculateDistance } from '../../../utils/location.utils';
import { calculateFareBreakdown } from '../../../utils/fareCalculator';
import { roundTo2 } from '../../../utils/number.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { assertSplitMinimumDistance } from '../../../utils/rideSchedule.utils';
import { getDepartureDateTime } from '../../../utils/rideSchedule.utils';
import { RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { toRiderPriceView } from '../../../utils/riderPriceResponse.utils';

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

    // Validate 30-min booking slots when time is provided.
    let departureDateTime = departureDate ? new Date(departureDate) : new Date();
    if (departureDate && departureTime) {
      departureDateTime = getDepartureDateTime(departureDate, departureTime);
    }

    let actualDistance = 0;
    let actualDuration = 0;
    try {
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng },
      );
      actualDistance = distanceKm;
      actualDuration = durationMinutes;
    } catch {
      actualDistance = calculateDistance(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng },
      );
      actualDuration = Math.ceil((actualDistance / 30) * 60);
      console.warn('Google Maps failed — using Haversine fallback');
    }

    if (type === RIDE_TYPE.split) {
      await assertSplitMinimumDistance(actualDistance);
    }

    const fareBreakdown = await calculateFareBreakdown({
      distanceKm: actualDistance,
      departureDate: departureDateTime,
      departureTime: departureTime || new Date().toLocaleTimeString(),
      luggageCount: luggageCounts || 0,
      requestedSeats,
      rideType: type,
      waitingMinutes: 0,
    });

    const price = toRiderPriceView({
      estimatedFare: fareBreakdown.totalFare,
      vatAmount: fareBreakdown.vatAmount,
      vatPercentage: fareBreakdown.platformVatPercent,
      vatIncluded: fareBreakdown.vatIncluded,
    });

    return callback?.({
      success: true,
      message: 'Estimated price calculated successfully.',
      data: {
        ...price,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        rideDetails: {
          bookingDate: departureDate || new Date().toISOString().split('T')[0],
          bookingTime: departureTime || new Date().toLocaleTimeString(),
          pickup,
          destination,
          rideType: type,
          requestedSeats,
          malePassengers: malePassengers || 0,
          femalePassengers: femalePassengers || 0,
          luggageCounts: luggageCounts || 0,
        },
      },
    });
  },
);
