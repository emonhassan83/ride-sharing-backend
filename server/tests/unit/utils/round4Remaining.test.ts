/**
 * QA round 4, remaining items:
 *  - driver wallet is only debited for an earning that was actually credited
 *  - refund status pushes have a real (translatable) title
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});

import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { buildRefundStatusNotification } from '@src/app/modules/refund/refund.utils';
import { revertDriverEarningIfCredited } from '@src/app/utils/driverEarning.utils';
import enLocale from '@src/app/i18n/locales/en/translation.json';
import elLocale from '@src/app/i18n/locales/el/translation.json';
import heLocale from '@src/app/i18n/locales/he/translation.json';
import ruLocale from '@src/app/i18n/locales/ru/translation.json';
import ukLocale from '@src/app/i18n/locales/uk/translation.json';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

describe('revertDriverEarningIfCredited', () => {
  const rideId = oidStr();
  const driverId = oidStr();

  beforeEach(() => {
    vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
  });

  it('does NOT debit when the ride was never completed/credited (the negative-wallet bug)', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery({ _id: rideId, driverEarningCredited: false }) as any);

    expect(await revertDriverEarningIfCredited({ rideId, driverId, amount: 20.4 })).toBe(0);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('debits exactly the earning when it was credited at completion', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery({ _id: rideId, driverEarningCredited: true }) as any);

    expect(await revertDriverEarningIfCredited({ rideId, driverId, amount: 20.4 })).toBe(20.4);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(driverId, { $inc: { wallet: -20.4 } });
  });

  it('ignores zero amounts, missing driver or missing ride without touching the DB', async () => {
    expect(await revertDriverEarningIfCredited({ rideId, driverId, amount: 0 })).toBe(0);
    expect(await revertDriverEarningIfCredited({ rideId, driverId: null, amount: 5 })).toBe(0);
    expect(await revertDriverEarningIfCredited({ rideId: null, driverId, amount: 5 })).toBe(0);
    expect(Ride.findById).not.toHaveBeenCalled();
  });
});

describe('buildRefundStatusNotification', () => {
  it('never returns an empty title', () => {
    for (const status of ['confirmed', 'rejected', 'pending', undefined]) {
      expect(buildRefundStatusNotification(status as any).message.length).toBeGreaterThan(0);
    }
  });

  it('approved → wallet text; rejected → the admin reason when given', () => {
    expect(buildRefundStatusNotification('confirmed', 'Refunded 20 to wallet')).toEqual({
      message: 'Refund Approved',
      description: 'Your refund has been added to your wallet.',
    });
    expect(buildRefundStatusNotification('rejected', 'Ride was completed')).toEqual({
      message: 'Refund Rejected',
      description: 'Ride was completed',
    });
    expect(buildRefundStatusNotification('rejected', '  ').description).toBe('Your refund request was rejected.');
  });

  it('every default string exists in all 5 locales', () => {
    const keys = ['confirmed', 'rejected', 'pending'].flatMap((s) => {
      const n = buildRefundStatusNotification(s);
      return [n.message, n.description];
    });
    for (const locale of [enLocale, elLocale, heLocale, ruLocale, ukLocale] as any[]) {
      for (const key of keys) expect(locale.messages[key], key).toBeTruthy();
    }
  });
});
