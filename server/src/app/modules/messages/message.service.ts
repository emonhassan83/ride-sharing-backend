import httpStatus from 'http-status'
import QueryBuilder from '../../builder/QueryBuilder'
import { TMessages } from './messages.interface'
import { Chat } from '../chat/chat.models'
import { chatService } from '../chat/chat.service'
import { io } from '../../../server'
import mongoose from 'mongoose'
import { Message } from './messages.model'
import ApiError from '../../errors/ApiError'

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

  const result = await Message.create(payload)
  if (!result) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Message creation failed')
  }

  if (io) {
    const senderMessage = `new-message::${result.chat.toString()}`
    io.to(`chat:${result.chat.toString()}`).emit(senderMessage, result)

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

// Update messages
const updateMessages = async (id: string, payload: Partial<TMessages>) => {
  const result = await Message.findByIdAndUpdate(id, payload, { returnDocument: 'after' })
  if (!result) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Message update failed')
  }
  return result
}

// Get messages by chat ID
const getMessagesByChatId = async (
  chatId: string,
  query: Record<string, any>,
) => {
  const chat = await Chat.findById(chatId)
  if (!chat) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Chat not found')
  }

  const messageQuery = new QueryBuilder(
    Message.find({ chat: chat._id })
      // .populate([{ path: 'sender', select: 'name profileImage _id' }])
      .select('text imageUrl seen sender createdAt')
      .sort({ createdAt: 1 }),
    query,
  )
    .filter()
    .paginate()
    .fields()

  const messages = await messageQuery.modelQuery
  const meta = await messageQuery.countTotal()

  // ✅ পুরনো থেকে নতুন order এ দাও
  const orderedMessages = [...messages].reverse()

  return { meta, data: orderedMessages }
}

// Get message by ID
const getMessagesById = async (id: string) => {
  const result = await Message.findById(id).populate([
    { path: 'sender', select: 'name profileImage _id' },
  ])
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }
  return result
}

const deleteMessages = async (id: string) => {
  const message = await Message.findById(id)
  if (!message) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }

  const result = await Message.findByIdAndDelete(id)
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Oops! Message not found')
  }
  return result
}

const seenMessage = async (userId: string, chatId: string) => {
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

const deleteMessagesByChatId = async (chatId: string) => {
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
}
