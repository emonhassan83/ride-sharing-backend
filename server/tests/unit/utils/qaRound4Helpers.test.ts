/**
 * QA round 4 (backend issue list of 23 Nov 2026): pure helpers behind the fixes.
 *  - B-18 contact masking before a driver accepts
 *  - B-14 deep-link routing data on every notification
 *  - B-22 machine-readable socket error codes, no internal error text for users
 *  - B-06 one payout breakdown that adds up to what the platform received
 *  - B-21 server-side trip start window
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});

import ApiError from '@src/app/errors/ApiError';
import { Setting } from '@src/app/modules/settings/settings.model';
import { handleSocketError } from '@src/app/socket/utils/handleSocketError';
import {
  assertCanViewRide,
  canSeeDriverContact,
  canSeeRiderContact,
  maskPhone,
  maskUserContact,
} from '@src/app/utils/contactPrivacy.utils';
import {
  buildDriverPayout,
  buildPassengerFareTotals,
  computeDriverPayoutFromPassengerTotal,
  resolveSplitMinimumFare,
  roundMoney,
} from '@src/app/utils/fareMath.utils';
import { getEarliestTripStart, getDepartureDateTime } from '@src/app/utils/rideSchedule.utils';
import { buildNotificationRoutingData } from '@src/app/utils/sentPushNotification';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { freezeTime } from '@tests/helpers/time';

describe('B-18: contact privacy', () => {
  const driverId = oidStr();
  const otherDriver = oidStr();
  const riderId = oidStr();
  const ride = { driverId, notifiedDriverIds: [driverId, otherDriver] };

  it('masks a phone, keeping country prefix and last 4 digits', () => {
    expect(maskPhone('+8801593578965')).toBe('+880••••••8965');
    expect(maskPhone(null)).toBeNull();
  });

  it('masks phone and hides email on a populated user', () => {
    expect(maskUserContact({ name: 'A', phone: '+35799123456', email: 'a@x.com' })).toEqual({
      name: 'A',
      phone: '+357••••3456',
      email: null,
      contactMasked: true,
    });
  });

  it('a notified (not assigned) driver never sees rider contact', () => {
    const requester = { userId: otherDriver, role: 'provider' };
    expect(canSeeRiderContact(requester, ride, { userId: riderId, status: 'pending' })).toBe(false);
    expect(canSeeRiderContact(requester, ride, { userId: riderId, status: 'confirmed' })).toBe(false);
  });

  it('the assigned driver sees contact only once that passenger is accepted', () => {
    const requester = { userId: driverId, role: 'provider' };
    expect(canSeeRiderContact(requester, ride, { userId: riderId, status: 'pending' })).toBe(false);
    expect(canSeeRiderContact(requester, ride, { userId: riderId, status: 'confirmed' })).toBe(true);
  });

  it('a rider sees their own contact and the driver only after being accepted', () => {
    const requester = { userId: riderId, role: 'user' };
    expect(canSeeRiderContact(requester, ride, { userId: riderId, status: 'pending' })).toBe(true);
    expect(canSeeDriverContact(requester, ride, [{ userId: riderId, status: 'pending' }])).toBe(false);
    expect(canSeeDriverContact(requester, ride, [{ userId: riderId, status: 'confirmed' }])).toBe(true);
  });

  it('admins see everything', () => {
    const admin = { userId: oidStr(), role: 'admin' };
    expect(canSeeRiderContact(admin, ride, { userId: riderId, status: 'pending' })).toBe(true);
  });

  it('strangers cannot read the ride at all', () => {
    expect(() => assertCanViewRide({ userId: oidStr(), role: 'user' }, ride, [riderId])).toThrow(
      'You do not have access to this ride',
    );
    expect(() => assertCanViewRide({ userId: otherDriver, role: 'provider' }, ride, [riderId])).not.toThrow();
    expect(() => assertCanViewRide({ userId: riderId, role: 'user' }, ride, [riderId])).not.toThrow();
  });
});

describe('B-14: notification routing data', () => {
  it('keeps caller data as strings and adds a screen hint', () => {
    expect(
      buildNotificationRoutingData({
        data: { type: 'RIDE_CANCELLED_BY_DRIVER', rideId: 'r1', refundAmount: 20 },
        reference: 'r1',
        modelType: 'Ride',
      }),
    ).toEqual({
      type: 'RIDE_CANCELLED_BY_DRIVER',
      rideId: 'r1',
      refundAmount: '20',
      reference: 'r1',
      modelType: 'Ride',
      screen: 'ride_details',
    });
  });

  it('gives older callers (KYC, refund, payment) a type derived from the model', () => {
    expect(buildNotificationRoutingData({ reference: 'p1', modelType: 'Provider' })).toMatchObject({
      type: 'KYC_STATUS',
      screen: 'home',
    });
    expect(buildNotificationRoutingData({ modelType: 'Refund' })).toMatchObject({
      type: 'REFUND_ISSUED',
      screen: 'wallet',
    });
  });

  it('routes chat pushes to the chat screen and fills rideId for ride notifications', () => {
    expect(buildNotificationRoutingData({ data: { type: 'CHAT_MESSAGE', chatId: 'c1' } }).screen).toBe('chat');
    expect(buildNotificationRoutingData({ reference: 'r9', modelType: 'Ride' }).rideId).toBe('r9');
  });
});

describe('B-22: socket error codes', () => {
  const socket = () => ({ emit: vi.fn() });

  it('an ApiError keeps its user message and gets a code from the status', () => {
    const s = socket();
    const ack = vi.fn();
    handleSocketError(new ApiError(404, 'Ride not found'), s as any, ack);
    expect(ack).toHaveBeenCalledWith({ success: false, status: 404, code: 'NOT_FOUND', message: 'Ride not found' });
    expect(s.emit).toHaveBeenCalledWith('socketError', expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('an explicit errorCode on ApiError wins', () => {
    const s = socket();
    const ack = vi.fn();
    const err = new ApiError(400, 'No active ride');
    err.errorCode = 'NO_ACTIVE_RIDE';
    handleSocketError(err, s as any, ack);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_ACTIVE_RIDE', message: 'No active ride' }));
  });

  it('an unexpected error never leaks its internal message', () => {
    const s = socket();
    const ack = vi.fn();
    handleSocketError(new Error('E11000 duplicate key in collection users'), s as any, ack);
    expect(ack).toHaveBeenCalledWith({
      success: false,
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong!',
    });
    const payload = s.emit.mock.calls[0][1];
    expect(JSON.stringify(payload)).not.toContain('E11000');
  });
});

describe('B-06: one payout breakdown', () => {
  const settings = {
    driverPlatformFeePercent: 15,
    driverVatPercent: 19,
    platformCommissionPercent: 10,
    splitRideMatchedSurchargePercent: 30,
  };

  it('the €40 matched split ride from QA: 9.23 markup + 4.62 fee + 4.97 VAT + 21.18 driver = 40.00', () => {
    const p = computeDriverPayoutFromPassengerTotal(40, 'split', settings, true);
    expect(p.komistraGross).toBe(30.77);
    expect(p.driverPlatformFeeAmount).toBe(4.62);
    expect(p.driverVatAmount).toBe(4.97);
    expect(p.driverEarningAmount).toBe(21.18);
    const markup = roundMoney(40 - p.komistraGross);
    expect(roundMoney(markup + p.driverPlatformFeeAmount + p.driverVatAmount + p.driverEarningAmount)).toBe(40);
  });

  it('the €20 private ride from QA pays the driver 12.51', () => {
    expect(computeDriverPayoutFromPassengerTotal(20, 'private', settings, false).driverEarningAmount).toBe(12.51);
  });

  it('gross = fee + VAT + earning for any amount', () => {
    for (const gross of [10, 18.18, 30.77, 99.99]) {
      const b = buildDriverPayout(gross, 15, 19);
      expect(roundMoney(b.driverPlatformFeeAmount + b.driverVatAmount + b.driverEarningAmount)).toBeCloseTo(
        b.driverGrossAmount,
        2,
      );
    }
  });
});

describe('B-16: configurable split minimum fare', () => {
  const base = {
    rideType: 'split' as const,
    rawComponentFare: 5,
    baseFare: 20,
    platformVatPercent: 9,
    platformCommissionPercent: 10,
    splitRideMatchedSurchargePercent: 30,
  };

  it('0 / unset falls back to baseFare (original behaviour)', () => {
    expect(resolveSplitMinimumFare(0, 20)).toBe(20);
    expect(resolveSplitMinimumFare(undefined, 20)).toBe(20);
    expect(resolveSplitMinimumFare(12, 20)).toBe(12);
    expect(buildPassengerFareTotals({ ...base, riderCount: 2 }).totalFare).toBe(20);
  });

  it('a lower split minimum makes a short matched split ride cheaper than private', () => {
    // 5 → +10% → €10 bracket → €20 min upfront; pool 40, avg 20, +30% = 26, /2 = 13 → €15.
    expect(buildPassengerFareTotals({ ...base, riderCount: 2, splitMinimumFare: 12 }).totalFare).toBe(15);
  });

  it('never changes private or unmatched riders', () => {
    expect(buildPassengerFareTotals({ ...base, riderCount: 1, splitMinimumFare: 12 }).totalFare).toBe(20);
    expect(
      buildPassengerFareTotals({ ...base, rideType: 'private', riderCount: 1, splitMinimumFare: 12 }).totalFare,
    ).toBe(20);
  });
});

describe('B-21: trip start window', () => {
  beforeEach(() => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery(null) as any); // default 30 minutes
  });

  it('refuses a start more than 30 minutes before pickup and returns the earliest start', async () => {
    const departAt = getDepartureDateTime('2026-11-23', '12:50');
    freezeTime(new Date(departAt.getTime() - 45 * 60 * 1000).toISOString());
    const earliest = await getEarliestTripStart('2026-11-23', '12:50');
    expect(earliest?.toISOString()).toBe(new Date(departAt.getTime() - 30 * 60 * 1000).toISOString());
  });

  it('allows a start inside the window', async () => {
    const departAt = getDepartureDateTime('2026-11-23', '12:50');
    freezeTime(new Date(departAt.getTime() - 10 * 60 * 1000).toISOString());
    expect(await getEarliestTripStart('2026-11-23', '12:50')).toBeNull();
  });

  it('uses the tripStartEarlyWindowMinutes setting when present', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ key: 'tripStartEarlyWindowMinutes', value: 60 }) as any);
    const departAt = getDepartureDateTime('2026-11-23', '12:50');
    freezeTime(new Date(departAt.getTime() - 45 * 60 * 1000).toISOString());
    expect(await getEarliestTripStart('2026-11-23', '12:50')).toBeNull();
  });

  it('never blocks the driver on a malformed schedule', async () => {
    expect(await getEarliestTripStart('garbage', '99:99')).toBeNull();
  });
});
