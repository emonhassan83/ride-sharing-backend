/**
 * Unit tests: FCM push helper used by the notification worker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ send }) }));

import { sendPushNotification } from '@/app/utils/push-notification.service';

beforeEach(() => {
  send.mockResolvedValue('projects/p/messages/abc');
});

const payload = {
  fcmToken: 'tok-1',
  title: 'Ride accepted',
  body: 'Driver is on the way',
  data: { rideId: 'r1', modelType: 'Ride' },
};

describe('sendPushNotification', () => {
  it('sends a high-priority message to the device and returns the FCM message id', async () => {
    const result = await sendPushNotification(payload);

    expect(result).toEqual({ success: true, messageId: 'projects/p/messages/abc' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      token: 'tok-1',
      notification: { title: 'Ride accepted', body: 'Driver is on the way' },
      data: { rideId: 'r1', modelType: 'Ride' },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' } },
    });
  });

  it('defaults `data` to an empty object', async () => {
    await sendPushNotification({ fcmToken: 't', title: 'a', body: 'b' });
    expect(send.mock.calls[0][0].data).toEqual({});
  });

  it.each([undefined, null, ''])('does not call FCM without a token (%s)', async (fcmToken) => {
    const result = await sendPushNotification({ ...payload, fcmToken: fcmToken as string });
    expect(result).toEqual({ success: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns success:false (never throws) when FCM rejects, e.g. an unregistered token', async () => {
    send.mockRejectedValue(Object.assign(new Error('Requested entity was not found.'), { code: 'messaging/registration-token-not-registered' }));

    await expect(sendPushNotification(payload)).resolves.toEqual({ success: false });
  });

  describe('FIXED BUGS (regression tests)', () => {
    // BUG-REPORT WORKER-5 | medium | worker/src/app/utils/push-notification.service.ts:21
    // FCM `data` payloads may only contain STRING values; the Admin SDK throws on numbers /
    // booleans / objects. `data` is forwarded untouched, while the server producer types it as
    // `any` (references, ids, flags, nested objects), so such pushes are rejected and (see
    // WORKER-3) silently lost. Fix: coerce values with String()/JSON.stringify before sending.
    it('BUG WORKER-5: non-string data values are coerced to strings before sending', async () => {
      await sendPushNotification({
        fcmToken: 't',
        title: 'a',
        body: 'b',
        data: { seats: 2, urgent: true, nested: { a: 1 } } as unknown as Record<string, string>,
      });

      const sent = send.mock.calls[0][0].data as Record<string, unknown>;
      expect(Object.values(sent).every((v) => typeof v === 'string')).toBe(true);
    });
  });
});
