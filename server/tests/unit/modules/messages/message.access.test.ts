/**
 * Chat message access: participants only.
 *
 * Regression: GET /message/my-messages/:chatId had no auth, and the other
 * message routes never checked who was asking, so any user could read, edit or
 * delete any conversation.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/chat/chat.models', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Chat: createModelMock() };
});
vi.mock('@src/app/modules/messages/messages.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Message: createModelMock() };
});
vi.mock('@src/app/modules/chat/chat.service', () => ({ chatService: { getMyChatList: vi.fn() } }));
vi.mock('@src/app/queues/chatPush.queue', () => ({
  clearPendingChatPushBatch: vi.fn(),
  enqueueChatPushNotification: vi.fn(),
  isUserActiveInChat: vi.fn(async () => false),
}));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));

import { Chat } from '@src/app/modules/chat/chat.models';
import { Message } from '@src/app/modules/messages/messages.model';
import { messagesService } from '@src/app/modules/messages/message.service';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

const chatId = oidStr();
const alice = oidStr();
const bob = oidStr();
const mallory = oidStr();

const wireChat = () =>
  vi.mocked(Chat.findById).mockReturnValue(
    mockQuery({ _id: chatId, participants: [alice, bob] }) as any,
  );
const wireMessage = () =>
  vi.mocked(Message.findById).mockReturnValue(
    mockQuery({ _id: oidStr(), chat: chatId, sender: alice, receiver: bob }) as any,
  );

describe('message access', () => {
  it('an outsider cannot read a chat; a participant and an admin can', async () => {
    wireChat();
    await expect(
      messagesService.getChatForParticipant(chatId, { userId: mallory, role: 'user' }),
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      messagesService.getChatForParticipant(chatId, { userId: bob, role: 'user' }),
    ).resolves.toBeTruthy();
    await expect(
      messagesService.getChatForParticipant(chatId, { userId: mallory, role: 'admin' }, { allowAdmin: true }),
    ).resolves.toBeTruthy();
  });

  it('only the sender can edit or delete a message', async () => {
    wireMessage();
    await expect(
      messagesService.updateMessages(oidStr(), { text: 'x' }, { userId: bob, role: 'user' }),
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      messagesService.deleteMessages(oidStr(), { userId: mallory, role: 'user' }),
    ).rejects.toMatchObject({ code: 403 });
    expect(Message.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Message.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it('an outsider cannot delete a whole chat', async () => {
    wireChat();
    await expect(
      messagesService.deleteMessagesByChatId(chatId, { userId: mallory, role: 'user' }),
    ).rejects.toMatchObject({ code: 403 });
    expect(Message.deleteMany).not.toHaveBeenCalled();
  });
});

describe('getMessagesByChatId order', () => {
  const rows = [{ _id: 'm1' }, { _id: 'm2' }, { _id: 'm3' }];

  it('default is unchanged: ascending query, page reversed', async () => {
    wireChat();
    const q = mockQuery(rows);
    vi.mocked(Message.find).mockReturnValue(q as any);

    const { data } = await messagesService.getMessagesByChatId(chatId, { page: '1' }, { userId: alice, role: 'user' });

    expect(q.sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(data.map((m: any) => m._id)).toEqual(['m3', 'm2', 'm1']);
  });

  it('opt-in ?order=desc: newest first, page 1 = newest, no reversal', async () => {
    wireChat();
    const q = mockQuery(rows);
    vi.mocked(Message.find).mockReturnValue(q as any);

    const { data } = await messagesService.getMessagesByChatId(chatId, { order: 'desc' }, { userId: alice, role: 'user' });

    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(data.map((m: any) => m._id)).toEqual(['m1', 'm2', 'm3']);
    expect(q.find).not.toHaveBeenCalled(); // `order` is not treated as a filter field
  });
});
