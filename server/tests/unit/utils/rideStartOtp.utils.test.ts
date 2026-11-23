/**
 * Issue 9: every pickup attempt / "resend OTP" created a NEW start code and sent a new
 * push + SMS + email. Now the current code is re-used while valid, and the same code
 * is pushed / texted at most once a minute.
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
vi.mock('@src/app/utils/queueHelper', () => ({ getEmailQueueInstance: vi.fn() }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/modules/notification/notification.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Notification: createModelMock() };
});

import { messaging } from '@src/app/config/firebase.config';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { getIO } from '@src/app/socket/socket.init';
import { getEmailQueueInstance } from '@src/app/utils/queueHelper';
import { getRideStartOtpKey, sendRideStartOtp } from '@src/app/utils/rideStartOtp.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo } from '@tests/helpers/socket';

const rideId = oidStr();
const driverId = oidStr();
const passengerId = oidStr();
const riderId = oidStr();
const emailAdd = vi.fn();

beforeEach(() => {
  vi.mocked(getIO).mockReturnValue(createMockIo() as any);
  vi.mocked(Ride.findById).mockReturnValue(
    mockQuery({ _id: rideId, status: 'accepted', driverId, type: 'private' }) as any,
  );
  vi.mocked(Passenger.find).mockReturnValue(
    mockQuery([{ _id: passengerId, userId: riderId, status: 'driver_arrived', rideId }]) as any,
  );
  vi.mocked(User.findById).mockReturnValue(
    mockQuery({ _id: riderId, name: 'R', email: 'r@example.com', phone: '+357', fcmToken: 'tok', language: 'en' }) as any,
  );
  vi.mocked(getEmailQueueInstance).mockResolvedValue({ add: emailAdd } as any);
  vi.mocked(messaging.sendEach).mockResolvedValue({ successCount: 1, failureCount: 0, responses: [] } as any);
});

const send = () =>
  sendRideStartOtp({ rideId, passengerId, requesterId: driverId, requesterRole: 'provider' });

describe('ISSUE 9: ride start OTP', () => {
  it('a second request within the validity re-uses the same code', async () => {
    const first = await send();
    const second = await send();

    expect(first.otp).toMatch(/^\d{6}$/);
    expect(second.otp).toBe(first.otp);
    expect(await fakeRedis.get(getRideStartOtpKey(rideId, passengerId))).toBe(first.otp);
  });

  it('the same code is pushed and emailed once, not on every request', async () => {
    await send();
    await send();
    await send();

    expect(messaging.sendEach).toHaveBeenCalledTimes(1);
    expect(emailAdd).toHaveBeenCalledTimes(1);
  });

  it('a code with under a minute left is replaced by a fresh one (and sent)', async () => {
    const first = await send();
    await fakeRedis.expire(getRideStartOtpKey(rideId, passengerId), 30);

    const second = await send();

    expect(second.otp).not.toBe(first.otp);
    expect(messaging.sendEach).toHaveBeenCalledTimes(2);
  });

  it('reports the real remaining validity of a re-used code', async () => {
    await send();
    await fakeRedis.expire(getRideStartOtpKey(rideId, passengerId), 300);

    const again = await send();

    expect(again.passengers[0].expiresInSeconds).toBe(300);
  });
});
