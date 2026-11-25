/**
 * Issue 8: "driver accepted but I got no notification / it came late".
 * Issue 9: "same notification multiple times" (start / pickup).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});
vi.mock('@src/app/modules/chat/chat.models', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Chat: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.service', () => ({
  PaymentService: { captureAuthorizedBookingPayment: vi.fn(), getBookingCaptureState: vi.fn() },
}));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn(async () => undefined) }));
vi.mock('@src/app/utils/sentPushNotification', () => ({ sendNotification: vi.fn() }));
vi.mock('@src/app/utils/maps.utils', () => ({ getRealDistanceAndETA: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', () => ({
  recalculateSplitFares: vi.fn(),
  getSplitMaxMatchedRiders: vi.fn(),
  lockSplitRideFare: vi.fn(),
}));
vi.mock('@src/app/utils/splitMatching.utils', () => ({
  getActiveSplitPassengersOnRide: vi.fn(async () => []),
}));
vi.mock('@src/app/utils/fareBreakdownResponse.utils', () => ({
  buildStoredFareBreakdown: vi.fn(async () => ({ totalFare: 20, vatAmount: 0, vatPercentage: 0, vatIncluded: true })),
}));
vi.mock('@src/app/utils/rideStartOtp.utils', () => ({
  isPassengerStartOtpVerified: vi.fn(async () => true),
  sendRideStartOtp: vi.fn(),
  verifyRideStartOtp: vi.fn(),
}));

import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Booking } from '@src/app/modules/booking/booking.model';
import { Vehicle } from '@src/app/modules/vehicle/vehicle.model';
import { PaymentService } from '@src/app/modules/payment/payment.service';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { getRealDistanceAndETA } from '@src/app/utils/maps.utils';
import { driverAcceptRideHandler } from '@src/app/socket/handlers/ride/driverAcceptRide.handler';
import { driverStartTripHandler } from '@src/app/socket/handlers/ride/driverStartTrip.handler';
import { pickUpRideHandler } from '@src/app/socket/handlers/ride/pickUpRideClean.handler';
import { getIO } from '@src/app/socket/socket.init';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oid, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket } from '@tests/helpers/socket';

const pushes = () => vi.mocked(notifyUserPush).mock.calls.map(([input]) => input as any);

describe('ISSUE 8: driver accepts a private ride', () => {
  let io: any;
  const driverId = oidStr();
  const otherDriver = oidStr();
  const rideId = oidStr();
  const riderId = oid();

  const accept = async () => {
    const ack = vi.fn();
    await (driverAcceptRideHandler as any).call(createMockSocket({ userId: driverId, role: 'provider' }), { rideId }, ack);
    return ack.mock.calls[0]?.[0];
  };

  beforeEach(async () => {
    io = createMockIo();
    vi.mocked(getIO).mockReturnValue(io);
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: driverId, name: 'D', isOnline: true, isDeleted: false, isKycVerified: true }) as any,
    );
    vi.mocked(Vehicle.findOne).mockReturnValue(mockQuery({ _id: oid(), seats: 4, name: 'Car', number: 'X' }) as any);
    vi.mocked(Ride.findById).mockReturnValue(
      mockQuery({ _id: rideId, type: 'private', status: 'pending', totalSeats: 4, notifiedDriverIds: [otherDriver] }) as any,
    );
    vi.mocked(Passenger.findOne).mockReturnValue(
      mockQuery(mockDoc({ userId: riderId, status: 'pending', estimatedFare: 20, pickup: { coordinates: [33.0, 35.0] } })) as any,
    );
    const booking = mockDoc({ userId: riderId, totalFare: 20 });
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(booking) as any);
    vi.mocked(Booking.findById).mockReturnValue(mockQuery(booking) as any);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValue(mockQuery({ _id: rideId, status: 'accepted' }) as any);
    vi.mocked(getRealDistanceAndETA).mockResolvedValue({ distanceKm: 2, durationMinutes: 6 } as any);
    await fakeRedis.set(`driver:${driverId}:current`, JSON.stringify({ lat: 35.01, lng: 33.01 }));
  });

  it('the rider screen is updated BEFORE the push (the event used to wait for the FCM round trip)', async () => {
    let eventsWhenPushStarted = -1;
    vi.mocked(notifyUserPush).mockImplementation(async () => {
      eventsWhenPushStarted = io.emittedEvents('ride:driver-accepted').length;
    });

    expect((await accept()).success).toBe(true);
    expect(eventsWhenPushStarted).toBe(1);
    expect(pushes().map((p) => p.message)).toEqual(['Driver Accepted Your Ride!']);
    expect(io.emittedTo(`driver:${otherDriver}`, 'ride:already-taken')).toHaveLength(1);
  });

  it('capture fails and NO money moved: ride goes back to searching, rider is told, other drivers are NOT told "taken"', async () => {
    vi.mocked(PaymentService.captureAuthorizedBookingPayment).mockRejectedValue(
      new Error('Payment requires re-authorization before this ride can be started'),
    );
    vi.mocked(PaymentService.getBookingCaptureState).mockResolvedValue('not_captured');

    const ack = await accept();

    expect(ack.success).toBe(false);
    const [claim, release] = vi.mocked(Ride.findOneAndUpdate).mock.calls;
    expect((claim[1] as any).$set.status).toBe('accepted');
    expect(release[0]).toMatchObject({ _id: rideId, driverId, status: 'accepted' });
    expect(release[1]).toEqual({ $set: { status: 'pending' }, $unset: { driverId: '', vehicleId: '' } });
    expect(pushes().map((p) => p.message)).toEqual(['Payment Needs Attention']);
    expect(io.emittedTo(`driver:${otherDriver}`, 'ride:already-taken')).toHaveLength(0);
    expect(io.emittedEvents('ride:driver-accepted')).toHaveLength(0);
  });

  it('capture fails AFTER money moved (or unknown): claim is kept so the same driver can retry safely', async () => {
    vi.mocked(PaymentService.captureAuthorizedBookingPayment).mockRejectedValue(new Error('WriteConflict'));
    for (const state of ['captured', 'unknown'] as const) {
      vi.mocked(Ride.findOneAndUpdate).mockClear();
      vi.mocked(notifyUserPush).mockClear();
      vi.mocked(PaymentService.getBookingCaptureState).mockResolvedValue(state);

      await accept();

      expect(vi.mocked(Ride.findOneAndUpdate).mock.calls).toHaveLength(1); // claim only, no release
      expect(pushes()).toEqual([]);
    }
  });
});

describe('ISSUE 9: start trip + pickup', () => {
  const driverId = oidStr();
  const rideId = oidStr();
  const riderId = oid();
  let io: any;

  beforeEach(() => {
    io = createMockIo();
    vi.mocked(getIO).mockReturnValue(io);
  });

  const start = async () => {
    const ack = vi.fn();
    await (driverStartTripHandler as any).call(createMockSocket({ userId: driverId, role: 'provider' }), { rideId }, ack);
    return ack.mock.calls[0]?.[0];
  };

  it('start + pickup send two DIFFERENT pushes, each with a dedupe key ("Driver On The Way", then "Trip Started!")', async () => {
    const passenger = mockDoc({ userId: riderId, status: 'confirmed' });
    vi.mocked(Ride.findById).mockReturnValueOnce(mockQuery({ _id: rideId, type: 'private', status: 'accepted', driverId }) as any);
    vi.mocked(Passenger.find).mockReturnValueOnce(mockQuery([passenger]) as any);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValueOnce(mockQuery({ _id: rideId, status: 'started' }) as any);
    await start();

    vi.mocked(Ride.findById).mockReturnValueOnce(
      mockQuery(mockDoc({ _id: rideId, type: 'private', status: 'started', driverId })) as any,
    );
    vi.mocked(Passenger.find).mockReturnValueOnce(
      mockQuery([mockDoc({ _id: passenger._id, userId: riderId, status: 'in_progress' })]) as any,
    );
    await (pickUpRideHandler as any).call(createMockSocket({ userId: driverId, role: 'provider' }), { rideId }, vi.fn());

    expect(pushes().map((p) => [p.message, p.dedupeKey])).toEqual([
      ['Driver On The Way', `trip-started:${passenger._id}`],
      ['Trip Started!', `picked-up:${passenger._id}`],
    ]);
  });

  it('the rider receives ride:trip-started ONCE at start (one emit to both rooms, was two emits)', async () => {
    vi.mocked(Ride.findById).mockReturnValueOnce(mockQuery({ _id: rideId, type: 'private', status: 'accepted', driverId }) as any);
    vi.mocked(Passenger.find).mockReturnValueOnce(mockQuery([mockDoc({ userId: riderId, status: 'confirmed' })]) as any);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValueOnce(mockQuery({ _id: rideId, status: 'started' }) as any);

    await start();

    const emits = io.emittedEvents('ride:trip-started');
    expect(emits).toHaveLength(1);
    expect(emits[0].rooms).toEqual([`ride:${rideId}`, `user:${riderId}`]);
  });

  it('a double tap on start runs once: the second request sees the ride already started and notifies nobody', async () => {
    const ride = { _id: rideId, type: 'private', status: 'accepted', driverId };
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(ride) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([mockDoc({ userId: riderId, status: 'confirmed' })]) as any);
    vi.mocked(Ride.findOneAndUpdate)
      .mockReturnValueOnce(mockQuery({ ...ride, status: 'started' }) as any)
      .mockReturnValueOnce(mockQuery(null) as any); // the atomic guard lost the race

    const [first, second] = await Promise.all([start(), start()]);

    expect(vi.mocked(Ride.findOneAndUpdate).mock.calls[0][0]).toEqual({ _id: rideId, status: 'accepted' });
    expect([first.success, second.success]).toEqual([true, true]);
    expect(second.data?.alreadyStarted ?? first.data?.alreadyStarted).toBe(true);
    expect(pushes()).toHaveLength(1);
    expect(io.emittedEvents('ride:trip-started')).toHaveLength(1);
  });
});
