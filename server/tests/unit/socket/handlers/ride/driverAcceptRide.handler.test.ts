/**
 * Issue 58: "while offline I accepted the ride".
 *
 * Before: the handler's comment said "offline drivers cannot accept rides", but the
 * code silently switched the driver online (DB + Redis) and accepted, while the app
 * still showed "offline". Now an offline driver is refused with a clear message and
 * the app is told its real status; nothing about the ride is touched.
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
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});
vi.mock('@src/app/modules/chat/chat.models', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Chat: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.service', () => ({
  PaymentService: { captureAuthorizedBookingPayment: vi.fn() },
}));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn() }));
vi.mock('@src/app/utils/sentPushNotification', () => ({ sendNotification: vi.fn() }));
vi.mock('@src/app/utils/maps.utils', () => ({ getRealDistanceAndETA: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', () => ({
  recalculateSplitFares: vi.fn(),
  getSplitMaxMatchedRiders: vi.fn(),
}));

import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { PaymentService } from '@src/app/modules/payment/payment.service';
import { driverAcceptRideHandler } from '@src/app/socket/handlers/ride/driverAcceptRide.handler';
import { getIO } from '@src/app/socket/socket.init';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket } from '@tests/helpers/socket';

const driverId = oidStr();
const rideId = oidStr();

const accept = async (isOnline: boolean) => {
  const socket = createMockSocket({ userId: driverId, role: 'provider' });
  const ack = vi.fn();
  vi.mocked(User.findById).mockReturnValue(
    mockQuery({ _id: driverId, name: 'Driver', isOnline, isDeleted: false, status: 'active' }) as any,
  );
  await (driverAcceptRideHandler as any).call(socket, { rideId, passengerId: oidStr() }, ack);
  return { socket, ack };
};

beforeEach(() => {
  vi.mocked(getIO).mockReturnValue(createMockIo() as any);
});

describe('ISSUE 58: offline drivers cannot accept rides', () => {
  it('refuses the accept with a clear, translatable message', async () => {
    const { ack } = await accept(false);

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'You are offline. Go online to accept rides.',
      }),
    );
  });

  it('tells the app the driver is offline so its toggle is correct', async () => {
    const { socket } = await accept(false);

    expect(socket.emittedEvent('driver:status')).toEqual([['driver:status', { isOnline: false }]]);
  });

  it('does NOT switch the driver online behind their back', async () => {
    await accept(false);

    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(await fakeRedis.sismember('users:online', driverId)).toBe(0);
  });

  it('does not touch the ride, the passenger or the payment', async () => {
    await accept(false);

    expect(Ride.findById).not.toHaveBeenCalled();
    expect(Ride.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Passenger.findOneAndUpdate).not.toHaveBeenCalled();
    expect(PaymentService.captureAuthorizedBookingPayment).not.toHaveBeenCalled();
  });

  it('an ONLINE driver gets past the online check (proceeds to load the ride)', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(null) as any);
    const { ack } = await accept(true);

    expect(ack).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'You are offline. Go online to accept rides.' }),
    );
  });
});
