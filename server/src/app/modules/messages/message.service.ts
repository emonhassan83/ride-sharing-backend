import httpStatus from 'http-status'
import QueryBuilder from '../../builder/QueryBuilder'
import { TMessages } from './messages.interface'
import { Chat } from '../chat/chat.models'
import { chatService } from '../chat/chat.service'
import { getIO } from '../../socket/socket.init'
import mongoose from 'mongoose'
import { Message } from './messages.model'
import ApiError from '../../errors/ApiError'
import {
  clearPendingChatPushBatch,
  enqueueChatPushNotification,
  isUserActiveInChat,
} from '../../queues/chatPush.queue'

export type TMessageRequester = { userId: string; role?: string }

const isAdmin = (requester: TMessageRequester) => requester.role === 'admin'

/** The chat, if the requester is one of its participants (or an admin). */
const getChatForParticipant = async (
  chatId: string,
  requester: TMessageRequester,
  { allowAdmin = false } = {},
) => {
  if (!mongoose.Types.ObjectId.isValid(String(chatId))) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Chat not found')
  }
  const chat = await Chat.findById(chatId)
  if (!chat) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Chat not found')
  }
  const isParticipant = (chat.participants || []).some(
    (p: any) => String(p?._id ?? p) === String(requester.userId),
  )
  if (!isParticipant && !(allowAdmin && isAdmin(requester))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You are not a participant of this chat')
  }
  return chat
}

/** The message, if the requester sent it (or, with `participant`, is in its chat). */
const getMessageForRequester = async (
  id: string,
  requester: TMessageRequester,
  access: 'sender' | 'participant',
) => {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }
  const message = await Message.findById(id)
  if (!message) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }
  const uid = String(requester.userId)
  const isSender = String(message.sender) === uid
  const isReceiver = String(message.receiver) === uid
  const allowed =
    access === 'sender' ? isSender : isSender || isReceiver || isAdmin(requester)
  if (!allowed) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      access === 'sender'
        ? 'You can only change your own messages'
        : 'You are not a participant of this chat',
    )
  }
  return message
}

const createMessages = async (payload: TMessages) => {
  const alreadyExists = await Chat.findOne({
    participants: { $all: [payload.sender, payload.receiver] },
  }).populate(['participants'])

  if (!alreadyExists) {
    const chatList = await Chat.create({
      participants: [payload.sender, payload.receiver],
    })
    payload.chat = chatList?._id
  } else {
    payload.chat = alreadyExists?._id
  }

  const chatIdStr = payload.chat.toString()
  const receiverIdStr = payload.receiver.toString()
  const senderIdStr = payload.sender.toString()

  const receiverActiveInChat = await isUserActiveInChat(chatIdStr, receiverIdStr)
  if (receiverActiveInChat) {
    payload.seen = true
  }

  const result = await Message.create(payload)
  if (!result) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Message creation failed')
  }

  // getIO() instead of importing `io` from server.ts: that import pulled the
  // whole server entry point (DB connect, listen, cron) into anything that
  // loaded the routes.
  let io: ReturnType<typeof getIO> | null = null
  try {
    io = getIO()
  } catch {
    io = null
  }

  if (io) {
    const senderMessage = `new-message::${result.chat.toString()}`
    io.to(`chat:${result.chat.toString()}`).emit(senderMessage, result)
    io.to(receiverIdStr).emit('new-message', result)

    const [ChatListSender, ChatListReceiver] = await Promise.all([
      chatService.getMyChatList(result.sender.toString(), {}),
      chatService.getMyChatList(result.receiver.toString(), {}),
    ])

    // ✅ সঠিক user কে সঠিক chat list পাঠাও
    io.to(result.sender.toString()).emit(
      `chat-list::${result.sender.toString()}`,
      ChatListSender,
    )
    io.to(result.receiver.toString()).emit(
      `chat-list::${result.receiver.toString()}`,
      ChatListReceiver,
    )

    // Unread notification
    const [senderUnread, receiverUnread] = await Promise.all([
      Message.countDocuments({ receiver: result.sender, seen: false }),
      Message.countDocuments({ receiver: result.receiver, seen: false }),
    ])

    io.to(result.sender.toString()).emit(
      `new-notifications::${result.sender.toString()}`,
      senderUnread,
    )
    io.to(result.receiver.toString()).emit(
      `new-notifications::${result.receiver.toString()}`,
      receiverUnread,
    )
  }

  if (!receiverActiveInChat) {
    await enqueueChatPushNotification({
      chatId: chatIdStr,
      senderId: senderIdStr,
      receiverId: receiverIdStr,
      text: payload.text,
      imageUrl: payload.imageUrl,
      messageId: result._id.toString(),
    })
  }

  return result
}

// Get all messages
const getAllMessages = async (query: Record<string, any>) => {
  const MessageModel = new QueryBuilder(
    Message.find().populate([
      {
        path: 'sender',
        select: 'name profileImage',
      },
    ]),
    query,
  )
    .filter()
    .paginate()
    .sort()
    .fields()

  const data = await MessageModel.modelQuery
  const meta = await MessageModel.countTotal()
  return {
    data,
    meta,
  }
}

// Update messages: only the sender, and only the text (the whole body used to
// be written, so anyone could rewrite sender/receiver/chat of any message).
const updateMessages = async (
  id: string,
  payload: Partial<TMessages>,
  requester: TMessageRequester,
) => {
  await getMessageForRequester(id, requester, 'sender')
  if (typeof payload.text !== 'string') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'text is required')
  }
  const result = await Message.findByIdAndUpdate(
    id,
    { $set: { text: payload.text, isEdited: true } },
    { returnDocument: 'after' },
  )
  if (!result) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Message update failed')
  }
  return result
}

// Get messages by chat ID
const getMessagesByChatId = async (
  chatId: string,
  query: Record<string, any>,
  requester: TMessageRequester,
) => {
  // This route had no auth at all: any chatId read the whole conversation.
  const chat = await getChatForParticipant(chatId, requester, { allowAdmin: true })

  // Opt-in ?order=desc: page 1 = NEWEST messages, items newest first. The
  // default (page 1 = oldest, items reversed within the page) is unchanged
  // because the web app relies on it.
  const newestFirst = String(query?.order || '').trim().toLowerCase() === 'desc'

  const messageQuery = new QueryBuilder(
    Message.find({ chat: chat._id })
      // .populate([{ path: 'sender', select: 'name profileImage _id' }])
      .select('text imageUrl seen isEdited sender createdAt')
      .sort(newestFirst ? { createdAt: -1, _id: -1 } : { createdAt: 1 }),
    query,
  )
    .filter()
    .paginate()
    .fields()

  const messages = await messageQuery.modelQuery
  const meta = await messageQuery.countTotal()

  // ✅ পুরনো থেকে নতুন order এ দাও
  const orderedMessages = newestFirst ? messages : [...messages].reverse()

  return { meta, data: orderedMessages }
}

// Get message by ID
const getMessagesById = async (id: string, requester: TMessageRequester) => {
  await getMessageForRequester(id, requester, 'participant')
  const result = await Message.findById(id).populate([
    { path: 'sender', select: 'name profileImage _id' },
  ])
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }
  return result
}

const deleteMessages = async (id: string, requester: TMessageRequester) => {
  await getMessageForRequester(id, requester, 'sender')

  const result = await Message.findByIdAndDelete(id)
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }
  return result
}

const seenMessage = async (userId: string, chatId: string) => {
  await clearPendingChatPushBatch(chatId, userId)

  const messageIdList = await Message.aggregate([
    {
      $match: {
        chat: new mongoose.Types.ObjectId(chatId),
        seen: false,
        sender: { $ne: new mongoose.Types.ObjectId(userId) },
      },
    },
    { $group: { _id: null, ids: { $push: '$_id' } } },
    { $project: { _id: 0, ids: 1 } },
  ])

  const unseenMessageIdList =
    messageIdList.length > 0 ? messageIdList[0].ids : []

  if (unseenMessageIdList.length === 0) {
    return { message: 'No messages to update' }
  }

  const updateMessages = await Message.updateMany(
    { _id: { $in: unseenMessageIdList } },
    { $set: { seen: true } },
  )

  return updateMessages
}

const deleteMessagesByChatId = async (chatId: string, requester: TMessageRequester) => {
  await getChatForParticipant(chatId, requester)
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const messageDeleteResult = await Message.deleteMany({
      chat: chatId,
    }).session(session)

    if (messageDeleteResult.deletedCount === 0) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        'No messages found for this chat',
      )
    }

    await session.commitTransaction()
    return messageDeleteResult
  } catch (error) {
    await session.abortTransaction()
    throw error
  } finally {
    session.endSession()
  }
}

export const messagesService = {
  createMessages,
  getMessagesByChatId,
  getMessagesById,
  updateMessages,
  getAllMessages,
  deleteMessages,
  seenMessage,
  deleteMessagesByChatId,
  getChatForParticipant,
}
