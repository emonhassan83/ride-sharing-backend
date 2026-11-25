/**
 * KYC on the socket: dispatch already skips drivers whose KYC is not verified,
 * but `driver:go-online` let them flip online anyway (and `driver:accept-ride`
 * accepted a direct emit). Unverified drivers are now refused; going OFFLINE
 * keeps working for them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/socket/utils/driverSync', () => ({ syncDriverState: vi.fn() }));
vi.mock('@src/app/utils/geo.utils', () => ({
  saveDriverLocation: vi.fn(),
  removeDriverLocation: vi.fn(),
}));

import { User } from '@src/app/modules/user/user.model';
import { Vehicle } from '@src/app/modules/vehicle/vehicle.model';
import { driverGoOnlineHandler } from '@src/app/socket/handlers/ride/driverGoOnline.handler';
import { driverGoOfflineSocketHandler } from '@src/app/socket/handlers/ride/driverGoOffline.handler';
import { getIO } from '@src/app/socket/socket.init';
import { KYC_NOT_VERIFIED_MESSAGE, isDriverKycVerified } from '@src/app/utils/kycGuard.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket } from '@tests/helpers/socket';

const driverId = oidStr();
const PICKUP = { lat: 35.1, lng: 33.3 };

const goOnline = async (driverFields: Record<string, unknown>) => {
  const socket = createMockSocket({ userId: driverId, role: 'provider' });
  const ack = vi.fn();
  vi.mocked(User.findById).mockReturnValue(
    mockQuery({ _id: driverId, name: 'Driver', isOnline: false, ...driverFields }) as any,
  );
  vi.mocked(Vehicle.findOne).mockReturnValue(
    mockQuery({ _id: oidStr(), name: 'Car', number: 'ABC123', seats: 4, isDefault: true }) as any,
  );
  await (driverGoOnlineHandler as any).call(socket, { ...PICKUP }, ack);
  return { socket, ack };
};

beforeEach(() => {
  vi.mocked(getIO).mockReturnValue(createMockIo() as any);
});

describe('isDriverKycVerified', () => {
  it('is true only for an explicit isKycVerified: true', () => {
    expect(isDriverKycVerified({ isKycVerified: true })).toBe(true);
    expect(isDriverKycVerified({ isKycVerified: false })).toBe(false);
    expect(isDriverKycVerified({})).toBe(false);
    expect(isDriverKycVerified(null)).toBe(false);
    expect(isDriverKycVerified(undefined)).toBe(false);
  });
});

describe('driver:go-online KYC gate', () => {
  it('refuses an unverified driver with the KYC message', async () => {
    const { ack } = await goOnline({ isKycVerified: false });

    expect(ack).toHaveBeenCalledWith({ success: false, message: KYC_NOT_VERIFIED_MESSAGE });
  });

  it('treats a missing isKycVerified flag as unverified', async () => {
    const { ack } = await goOnline({});

    expect(ack).toHaveBeenCalledWith({ success: false, message: KYC_NOT_VERIFIED_MESSAGE });
  });

  it('tells the app it is still offline and changes no state', async () => {
    const { socket } = await goOnline({ isKycVerified: false });

    expect(socket.emittedEvent('driver:status')).toEqual([['driver:status', { isOnline: false }]]);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Vehicle.findOne).not.toHaveBeenCalled();
    expect(await fakeRedis.sismember('users:online', driverId)).toBe(0);
    expect(await fakeRedis.exists(`driver:${driverId}:details`)).toBe(0);
    expect(socket.join).not.toHaveBeenCalledWith(`driver:${driverId}`);
  });

  it('lets a verified driver go online', async () => {
    const { ack } = await goOnline({ isKycVerified: true });

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'You are now online and available for rides' }),
    );
    expect(await fakeRedis.sismember('users:online', driverId)).toBe(1);
  });
});

describe('driver:go-offline for unverified drivers', () => {
  it('still succeeds (no KYC check on the way out)', async () => {
    await fakeRedis.sadd('users:online', driverId);
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: driverId, isKycVerified: false, location: { coordinates: [0, 0] } }) as any,
    );
    vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQuery({}) as any);
    const socket = createMockSocket({ userId: driverId, role: 'provider' });
    const ack = vi.fn();

    await (driverGoOfflineSocketHandler as any).call(socket, { ...PICKUP }, ack);

    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Driver offline successfully' });
    expect(await fakeRedis.sismember('users:online', driverId)).toBe(0);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      driverId,
      expect.objectContaining({ isOnline: false }),
    );
  });
});
