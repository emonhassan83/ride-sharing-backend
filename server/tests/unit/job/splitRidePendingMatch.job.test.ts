/**
 * Issue 15: "it says it will look for a split partner for 1 hour, but after 25 minutes
 * it converted my ride to Solo".
 *
 * Root cause: for a rider left ALONE on an existing split ride (their partner
 * cancelled, or they joined someone else's ride), the "searched for 1 hour" check used
 * the RIDE's createdAt. A ride created 2 hours earlier made a rider who booked 25
 * minutes ago look like they had already searched for 2 hours.
 *
 * Time: now = 2026-11-23T10:00Z = 12:00 in Nicosia (UTC+2). Pickup 12:50 local
 * (50 min away, inside the 1 h Solo window). `matchingLastNotifyHours` = default 1 hour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('stripe', async () => {
  const { createStripeMock } = await import('@tests/helpers/stripeMock');
  const instance = createStripeMock();
  return { default: vi.fn(function () { return instance; }) };
});
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Payment: createModelMock() };
});
vi.mock('@src/app/modules/refund/refund.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Refund: createModelMock() };
});
vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/notifyDrivers.utils', () => ({
  emitNewRideRequestToDriver: vi.fn(),
  notifyNearbyDrivers: vi.fn(),
  notifyNearbyDriversForSplitRide: vi.fn(),
  notifyRiderDriversNotified: vi.fn(),
}));
vi.mock('@src/app/utils/splitFare.utils', () => ({
  refundToWallet: vi.fn(),
  recalculateSplitFares: vi.fn(),
  getSplitMaxMatchedRiders: vi.fn(),
}));
vi.mock('@src/app/utils/sentPushNotification', () => ({ sendNotification: vi.fn() }));
vi.mock('@src/app/utils/maps.utils', () => ({ getRouteGeometry: vi.fn() }));

import {
  checkSplitRidePendingMatches,
  hoursSinceSearchStarted,
  isSoloFallbackDue,
} from '@src/app/job/splitRidePendingMatch.job';
import { Booking } from '@src/app/modules/booking/booking.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { Setting } from '@src/app/modules/settings/settings.model';
import { getIO } from '@src/app/socket/socket.init';
import { notifyNearbyDrivers } from '@src/app/utils/notifyDrivers.utils';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo } from '@tests/helpers/socket';
import { freezeTime } from '@tests/helpers/time';

const NOW = '2026-11-23T10:00:00Z';
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000);

describe('isSoloFallbackDue (unchanged rule, 1 h setting)', () => {
  it.each([
    // [minutes until pickup, minutes searched, due?]
    [120, 120, false], // pickup still outside the 1 h window
    [60, 60, true], // full hour searched, pickup 1 h away
    [85, 25, false], // ISSUE 15 case: only 25 min searched -> keep searching
    [59, 25, false], // inside window but searched < 1 h and pickup > 15 min away
    [15, 25, true], // last call 15 min before pickup
    [0, 300, false], // pickup reached: no conversion (cancelled by other jobs)
  ])('pickup in %i min, searched %i min -> %s', (untilMin, searchedMin, due) => {
    expect(isSoloFallbackDue(untilMin / 60, searchedMin / 60, 1)).toBe(due);
  });
});

describe('hoursSinceSearchStarted', () => {
  const now = new Date(NOW);
  it("uses the rider's own request time, not the ride's", () => {
    expect(hoursSinceSearchStarted({ createdAt: minutesAgo(25) }, { createdAt: minutesAgo(120) }, now)).toBeCloseTo(25 / 60);
  });
  it("falls back to the ride's time only when the rider's is unknown", () => {
    expect(hoursSinceSearchStarted({}, { createdAt: minutesAgo(90) }, now)).toBeCloseTo(1.5);
  });
  it('never returns a negative value', () => {
    expect(hoursSinceSearchStarted({ createdAt: new Date(Date.parse(NOW) + 60_000) }, {}, now)).toBe(0);
  });
});

describe('ISSUE 15: lone rider on an older split ride', () => {
  const rideId = oidStr();
  const passengerId = oidStr();
  const riderId = oidStr();

  const seed = (riderRequestedMinutesAgo: number) => {
    const ride = {
      _id: rideId,
      type: 'split',
      status: 'pending',
      departureDate: '2026-11-23',
      departureTime: '12:50', // local; 50 min from now
      createdAt: minutesAgo(120), // created by the partner who later cancelled
    };
    const lone = {
      _id: passengerId,
      userId: riderId,
      rideId,
      status: 'pending',
      paymentStatus: 'authorized',
      pickup: { type: 'Point', coordinates: [33.38, 35.18] },
      destination: { type: 'Point', coordinates: [33.0, 34.7] },
      createdAt: minutesAgo(riderRequestedMinutesAgo),
    };
    vi.mocked(Ride.find).mockReturnValueOnce(mockQuery([ride]) as any);
    vi.mocked(Passenger.find).mockReturnValueOnce(mockQuery([lone]) as any); // riders on the ride
    vi.mocked(Booking.findOne).mockResolvedValue(mockDoc({ _id: oidStr(), passengerId, rideId }) as any);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValue(mockQuery({ ...ride, type: 'private' }) as any);
    vi.mocked(Passenger.findByIdAndUpdate).mockReturnValue(mockQuery(lone) as any);
    vi.mocked(Ride.findById).mockReturnValue(mockQuery({ notifiedDriverIds: [] }) as any);
  };

  beforeEach(() => {
    freezeTime(NOW);
    vi.mocked(getIO).mockReturnValue(createMockIo() as any);
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery(null) as any); // defaults: 1 h
    vi.mocked(notifyNearbyDrivers).mockResolvedValue(0);
  });

  it('rider requested 25 min ago on a ride created 2 h ago, pickup in 50 min: NOT converted yet (was converted before the fix)', async () => {
    seed(25);

    await checkSplitRidePendingMatches();

    // The lone-ride path really ran (not skipped earlier) ...
    expect(Passenger.find).toHaveBeenCalledWith(expect.objectContaining({ rideId }));
    // ... and decided the rider has not searched long enough yet.
    expect(Ride.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notifyNearbyDrivers).not.toHaveBeenCalled();
  });

  it('rider has searched for 65 min, pickup in 50 min: converted to Solo and released to drivers', async () => {
    seed(65);

    await checkSplitRidePendingMatches();

    expect(Ride.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: rideId, type: 'split' }),
      { type: 'private' },
      expect.anything(),
    );
    expect(notifyNearbyDrivers).toHaveBeenCalledTimes(1);
  });
});
