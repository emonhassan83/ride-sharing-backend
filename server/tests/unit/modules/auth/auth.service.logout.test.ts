/**
 * Issue 15 (part 1): "I got a notification even though I had logged out".
 *
 * Push: logout already cleared `fcmToken` (kept, and asserted below).
 * Socket: logout only left the `user:` / `driver:` rooms. The socket stayed CONNECTED
 * and stayed in `<userId>`, `ride:<id>` and `chat:<id>`, so the logged-out app still
 * received `new-message`, `new-notifications`, `chat-list` and ride updates and could
 * show them as in-app notifications. Now every socket of the user is disconnected and
 * the user's chat presence is cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('twilio', () => ({ default: vi.fn(() => ({ messages: { create: vi.fn() } })) }));
vi.mock('@src/app/utils/queueHelper', () => ({ getEmailQueueInstance: vi.fn() }));
vi.mock('@src/app/redis/helpers', () => ({ deleteCache: vi.fn(async () => undefined) }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn(), onlineUsers: {} }));
vi.mock('@src/app/queues/chatPush.queue', () => ({ clearAllActiveChatsForUser: vi.fn() }));
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});

import { AuthService } from '@src/app/modules/auth/auth.service';
import { User } from '@src/app/modules/user/user.model';
import { getIO, onlineUsers } from '@src/app/socket/socket.init';
import { clearAllActiveChatsForUser } from '@src/app/queues/chatPush.queue';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

const userId = oidStr();
let disconnectSockets: ReturnType<typeof vi.fn>;
let inRoom: ReturnType<typeof vi.fn>;

beforeEach(() => {
  disconnectSockets = vi.fn();
  inRoom = vi.fn(() => ({ disconnectSockets, socketsLeave: vi.fn() }));
  vi.mocked(getIO).mockReturnValue({ in: inRoom } as any);
  vi.mocked(User.findById).mockResolvedValue({ _id: userId, isDeleted: false } as any);
  vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQuery({}) as any);
  (onlineUsers as any)[userId] = { id: 'sock-1' };
});

describe('ISSUE 15: logout stops everything reaching the device', () => {
  it('clears the FCM token and the online flag (no more push notifications)', async () => {
    await AuthService.logoutUser(userId);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ fcmToken: null, isOnline: false }),
      expect.anything(),
    );
  });

  it('disconnects every socket of the user (they all join the bare <userId> room)', async () => {
    await AuthService.logoutUser(userId);

    expect(inRoom).toHaveBeenCalledWith(userId);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect((onlineUsers as any)[userId]).toBeUndefined();
  });

  it("clears the user's chat presence so a later login gets chat pushes", async () => {
    await AuthService.logoutUser(userId);

    expect(clearAllActiveChatsForUser).toHaveBeenCalledWith(userId);
  });

  it('removes the driver from the live dispatch sets', async () => {
    await fakeRedis.sadd('users:online', userId);
    await fakeRedis.geoadd('drivers:location', 33.3, 35.1, userId);

    await AuthService.logoutUser(userId);

    expect(await fakeRedis.sismember('users:online', userId)).toBe(0);
    expect(await fakeRedis.zscore('drivers:location', userId)).toBeNull();
  });

  it('a socket error never fails the logout request', async () => {
    vi.mocked(getIO).mockImplementation(() => {
      throw new Error('Socket.IO not initialized');
    });

    await expect(AuthService.logoutUser(userId)).resolves.toBeNull();
  });
});
