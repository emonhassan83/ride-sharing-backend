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
import { config } from '@src/app/config/env.config';
import {
  buildNotificationUrl,
  buildPushDeliveryOptions,
  buildWebPushLink,
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

describe('web push routing: recipientRole, url and webpush link', () => {
  const receiver = oidStr();
  const originalClientUrl = config.client.url;

  beforeEach(() => {
    config.client.url = originalClientUrl;
    vi.mocked(messaging.sendEach).mockResolvedValue(ok() as any);
  });

  const send = async (data: Record<string, string>, extra: Record<string, unknown> = {}) => {
    await sendNotification(['tok'], { receiver, message: 'T', description: 'B', skipPersist: true, data, ...extra });
    const calls = vi.mocked(messaging.sendEach).mock.calls;
    return (calls[calls.length - 1][0] as any[])[0];
  };

  describe('buildNotificationUrl', () => {
    it('chat goes to the conversation for every role', () => {
      for (const role of ['user', 'provider', 'admin', null]) {
        expect(buildNotificationUrl({ type: 'CHAT_MESSAGE', chatId: 'c 1' }, role)).toBe('/message?chat=c%201');
      }
      expect(buildNotificationUrl({ type: 'CHAT_MESSAGE' }, 'user')).toBe('/message');
    });

    it('passenger: own ride page by passenger id, else the list', () => {
      expect(buildNotificationUrl({ type: 'RIDE_ACCEPTED', rideId: 'r1', passengerId: 'p1' }, 'user')).toBe('/my-rides/p1');
      expect(buildNotificationUrl({ type: 'RIDE_UPDATE', modelType: 'Passenger', reference: 'p2' }, 'user')).toBe('/my-rides/p2');
      expect(buildNotificationUrl({ type: 'RIDE_START_OTP', passengerId: 'p3' }, 'user')).toBe('/my-rides/p3');
      expect(buildNotificationUrl({ type: 'RIDE_UPDATE', rideId: 'r1' }, 'user')).toBe('/my-rides');
      expect(buildNotificationUrl({ type: 'REFUND_ISSUED', passengerId: 'p1' }, 'user')).toBe('/my-rides');
      expect(buildNotificationUrl({ type: 'BOOKING_UPDATE', bookingId: 'b1' }, 'user')).toBe('/my-rides');
      expect(buildNotificationUrl({ type: 'GENERAL' }, 'user')).toBe('/book');
    });

    it('driver: new request -> /driver, ride -> its page, money -> payments', () => {
      expect(buildNotificationUrl({ type: 'NEW_RIDE_REQUEST', rideId: 'r1' }, 'provider')).toBe('/driver');
      expect(buildNotificationUrl({ type: 'RIDE_UPDATE', rideId: 'r1' }, 'provider')).toBe('/driver/my-rides/r1');
      expect(buildNotificationUrl({ type: 'BOOKING_UPDATE', bookingId: 'b1' }, 'provider')).toBe('/driver/my-rides');
      expect(buildNotificationUrl({ type: 'WITHDRAW_STATUS' }, 'provider')).toBe('/driver/my-payments');
      expect(buildNotificationUrl({ type: 'PAYMENT_UPDATE', rideId: 'r1' }, 'provider')).toBe('/driver/my-payments');
      expect(buildNotificationUrl({ type: 'KYC_STATUS' }, 'provider')).toBe('/driver');
      expect(buildNotificationUrl({ type: 'GENERAL' }, 'provider')).toBe('/driver');
    });

    it('admin: bookings / withdraw requests / refunds / dashboard', () => {
      expect(buildNotificationUrl({ type: 'BOOKING_UPDATE', modelType: 'Booking' }, 'admin')).toBe('/admin/bookings');
      expect(buildNotificationUrl({ type: 'WITHDRAW_STATUS' }, 'admin')).toBe('/admin/withdraw-request');
      expect(buildNotificationUrl({ type: 'REFUND_ISSUED' }, 'admin')).toBe('/admin/refunds');
      expect(buildNotificationUrl({ type: 'GENERAL' }, 'admin')).toBe('/admin/dashboard');
    });

    it('no role and no chat: no url (the web app falls back to its own rules)', () => {
      expect(buildNotificationUrl({ type: 'RIDE_UPDATE', rideId: 'r1' }, null)).toBeNull();
    });
  });

  it('adds recipientRole + url from the receiver looked up in the DB', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: receiver, role: 'provider', language: 'en' }) as any);

    const msg = await send({ type: 'RIDE_UPDATE', rideId: 'r1' });

    expect(msg.data).toMatchObject({ recipientRole: 'provider', url: '/driver/my-rides/r1', rideId: 'r1' });
  });

  it('uses a recipientRole passed by the caller', async () => {
    const msg = await send({ type: 'RIDE_ACCEPTED', passengerId: 'p1' }, { recipientRole: 'user' });

    expect(msg.data).toMatchObject({ recipientRole: 'user', url: '/my-rides/p1' });
  });

  it('keeps a url set by the caller', async () => {
    const msg = await send({ type: 'GENERAL', url: '/terms' }, { recipientRole: 'user' });

    expect(msg.data.url).toBe('/terms');
  });

  it('unknown receiver: no recipientRole, push still sent', async () => {
    const msg = await send({ type: 'RIDE_UPDATE', rideId: 'r1' });

    expect(msg.data.recipientRole).toBeUndefined();
    expect(msg.data.url).toBeUndefined();
    expect(msg.webpush).toBeUndefined();
  });

  it('sets webpush.fcmOptions.link from an https CLIENT_URL, keeping android/apns intact', async () => {
    config.client.url = 'https://app.example.com/';

    const msg = await send({ type: 'CHAT_MESSAGE', chatId: 'c1' }, { recipientRole: 'provider' });

    expect(msg.webpush).toEqual({ fcmOptions: { link: 'https://app.example.com/message?chat=c1' } });
    expect(msg.notification).toEqual({ title: 'T', body: 'B' });
    expect(msg.android.priority).toBe('high');
    expect(msg.apns.payload.aps.sound).toBe('default');
  });

  it('no webpush link for a non-https or missing CLIENT_URL (FCM would reject the whole message)', async () => {
    expect(buildWebPushLink('/driver')).toBeNull(); // vitest CLIENT_URL is http://localhost:3000
    config.client.url = undefined;
    expect(buildWebPushLink('/driver')).toBeNull();
    config.client.url = 'https://app.example.com';
    expect(buildWebPushLink('/driver')).toBe('https://app.example.com/driver');
    expect(buildWebPushLink(null)).toBeNull();
    expect(buildWebPushLink('https://evil.example/x')).toBeNull();

    config.client.url = 'http://localhost:3000';
    const msg = await send({ type: 'CHAT_MESSAGE', chatId: 'c1' }, { recipientRole: 'user' });
    expect(msg.webpush).toBeUndefined();
    expect(msg.data.url).toBe('/message?chat=c1');
  });
});

describe('notifyUserPush passes the recipient role to the push', () => {
  it('a passenger push carries recipientRole=user and the passenger ride url', async () => {
    const userId = oidStr();
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: userId, fcmToken: 'tok-p', language: 'en', role: 'user' }) as any,
    );
    vi.mocked(messaging.sendEach).mockResolvedValue(ok() as any);

    await notifyUserPush({
      userId,
      message: 'Driver Accepted Your Ride!',
      description: 'x',
      reference: 'p9',
      modelType: 'Passenger' as any,
      data: { type: 'RIDE_ACCEPTED', rideId: 'r9', passengerId: 'p9' },
    });

    const [msg] = vi.mocked(messaging.sendEach).mock.calls[0][0] as any[];
    expect(msg.data).toMatchObject({ recipientRole: 'user', url: '/my-rides/p9' });
  });
});
