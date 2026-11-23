/**
 * Issue 4 ("late notifications") and issue 8 ("no notification after accept").
 *
 *  - FCM messages had no expiry: a phone that was offline / in Doze got every ride
 *    update in a burst, long after the ride. Live ride updates now expire after
 *    10 min (other pushes after 24 h), and newer pushes for the same ride + event
 *    REPLACE the older one (Android tag/collapseKey, iOS apns-collapse-id).
 *  - One transient FCM failure lost the push for good; dead tokens were never cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/notification/notification.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Notification: createModelMock() };
});

import { messaging } from '@src/app/config/firebase.config';
import { Notification } from '@src/app/modules/notification/notification.model';
import { User } from '@src/app/modules/user/user.model';
import { notifyUserPush, PUSH_MAX_ATTEMPTS } from '@src/app/utils/notifyUser.utils';
import {
  buildPushDeliveryOptions,
  DEFAULT_TTL_SECONDS,
  RIDE_STATE_TTL_SECONDS,
  sendNotification,
} from '@src/app/utils/sentPushNotification';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

const ok = (n = 1) => ({ successCount: n, failureCount: 0, responses: [{ success: true }] });
const fail = (code: string) => ({
  successCount: 0,
  failureCount: 1,
  responses: [{ success: false, error: { code } }],
});

describe('ISSUE 4: FCM message expiry and collapsing', () => {
  it('live ride updates expire after 10 minutes', () => {
    for (const type of ['RIDE_ACCEPTED', 'DRIVER_ARRIVED', 'TRIP_STARTED', 'DRIVERS_NOTIFIED', 'NEW_RIDE_REQUEST']) {
      expect(buildPushDeliveryOptions({ type, rideId: 'r1' }).ttlSeconds).toBe(RIDE_STATE_TTL_SECONDS);
    }
    expect(RIDE_STATE_TTL_SECONDS).toBe(600);
  });

  it('other pushes (payments, chat, refunds) keep 24 h, never the FCM default of 4 weeks', () => {
    expect(buildPushDeliveryOptions({ type: 'CHAT_MESSAGE', chatId: 'c1' }).ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    expect(buildPushDeliveryOptions({}).ttlSeconds).toBe(24 * 60 * 60);
  });

  it('collapse key = event + passenger (or ride / chat), so a newer push replaces the older one', () => {
    expect(buildPushDeliveryOptions({ type: 'DRIVER_ARRIVED', rideId: 'r1', passengerId: 'p1' }).collapseKey).toBe(
      'DRIVER_ARRIVED:p1',
    );
    expect(buildPushDeliveryOptions({ type: 'CHAT_MESSAGE', chatId: 'c9' }).collapseKey).toBe('CHAT_MESSAGE:c9');
    expect(buildPushDeliveryOptions({ type: 'X' }).collapseKey).toBeNull();
  });

  it('the message sent to FCM carries ttl, tag/collapseKey, apns expiry/priority/collapse-id', async () => {
    vi.mocked(messaging.sendEach).mockResolvedValue(ok() as any);
    const before = Math.floor(Date.now() / 1000);

    await sendNotification(['tok'], {
      message: 'Driver Has Arrived!',
      description: 'Your driver has arrived at your pickup location',
      skipPersist: true,
      data: { type: 'DRIVER_ARRIVED', rideId: 'r1', passengerId: 'p1' },
    });

    const [msg] = vi.mocked(messaging.sendEach).mock.calls[0][0] as any[];
    expect(msg.android.ttl).toBe(600_000);
    expect(msg.android.collapseKey).toBe('DRIVER_ARRIVED:p1');
    expect(msg.android.notification.tag).toBe('DRIVER_ARRIVED:p1');
    expect(msg.apns.headers['apns-priority']).toBe('10');
    expect(msg.apns.headers['apns-collapse-id']).toBe('DRIVER_ARRIVED:p1');
    const expiry = Number(msg.apns.headers['apns-expiration']);
    expect(expiry).toBeGreaterThanOrEqual(before + 600);
    expect(expiry).toBeLessThanOrEqual(before + 602);
  });

  it('the Android channel is only set when FCM_ANDROID_CHANNEL_ID is configured', () => {
    expect(buildPushDeliveryOptions({ type: 'X' }).channelId).toBeNull();
    vi.stubEnv('FCM_ANDROID_CHANNEL_ID', 'ride_updates');
    expect(buildPushDeliveryOptions({ type: 'X' }).channelId).toBe('ride_updates');
  });
});

describe('ISSUE 8: a push is not lost to one FCM failure', () => {
  const userId = oidStr();

  beforeEach(() => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: userId, fcmToken: 'tok-1', language: 'en' }) as any);
    vi.mocked(User.updateOne).mockReturnValue(mockQuery({}) as any);
  });

  const accepted = () =>
    notifyUserPush({
      userId,
      message: 'Driver Accepted Your Ride!',
      description: 'Your driver is on the way. ETA: 5 minutes.',
      reference: 'p1',
      modelType: 'Passenger' as any,
      dedupeKey: 'ride-accepted:p1',
      data: { type: 'RIDE_ACCEPTED', rideId: 'r1', passengerId: 'p1' },
    });

  it('a transient failure is retried: delivered on the 2nd attempt, ONE in-app row', async () => {
    vi.mocked(messaging.sendEach)
      .mockResolvedValueOnce(fail('messaging/internal-error') as any)
      .mockResolvedValueOnce(ok() as any);

    await accepted();

    expect(messaging.sendEach).toHaveBeenCalledTimes(2);
    expect(Notification.create).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${PUSH_MAX_ATTEMPTS} attempts`, async () => {
    vi.mocked(messaging.sendEach).mockResolvedValue(fail('messaging/server-unavailable') as any);

    await accepted();

    expect(messaging.sendEach).toHaveBeenCalledTimes(PUSH_MAX_ATTEMPTS);
  });

  it('a dead token (app uninstalled / token rotated) is removed and not retried', async () => {
    vi.mocked(messaging.sendEach).mockResolvedValue(fail('messaging/registration-token-not-registered') as any);

    await accepted();

    expect(messaging.sendEach).toHaveBeenCalledTimes(1);
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: userId, fcmToken: 'tok-1' },
      { $set: { fcmToken: null } },
    );
  });

  it('the same dedupe key is still sent only once', async () => {
    vi.mocked(messaging.sendEach).mockResolvedValue(ok() as any);

    await accepted();
    await accepted();

    expect(messaging.sendEach).toHaveBeenCalledTimes(1);
  });
});
