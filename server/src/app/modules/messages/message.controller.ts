import { Request, Response } from 'express'
import catchAsync from '../../utils/catchAsync'
import { messagesService } from './message.service'
import sendResponse from '../../utils/sendResponse'
import httpStatus from 'http-status'
import { TChat } from '../chat/chat.interface'
import { Chat } from '../chat/chat.models'
import { chatService } from '../chat/chat.service'
import { io } from '../../../server'
import ApiError from '../../errors/ApiError'

const createMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.createMessages(req.body)

  sendResponse(res, {
    code: 200,
    message: 'Message sent successfully',
    data: result,
  })
})

// Get messages by chat ID
const getMessagesByChatId = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.getMessagesByChatId(req.params.chatId as string, req.query)

  sendResponse(res, {
    code: 200,
    message: 'Messages retrieved successfully',
    pagination: result.meta,
    data: result.data,
  })
})

// Get message by ID
const getMessagesById = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.getMessagesById(req.params.id as string)

  sendResponse(res, {
    code: 200,
    message: 'Message retrieved successfully',
    data: result,
  })
})

// Update message
const updateMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.updateMessages(req.params.id as string, req.body)

  sendResponse(res, {
    code: 200,
    message: 'Message updated successfully',
    data: result,
  })
})

//seen messages
const seenMessage = catchAsync(async (req: Request, res: Response) => {
  const chatList: TChat | null = await Chat.findById(req.params.chatId)
  if (!chatList) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'chat id is not valid')
  }

  const result = await messagesService.seenMessage(
    req.user._id,
    req.params.chatId as string,
  )

  const user1 = chatList.participants[0]
  const user2 = chatList.participants[1]
  // //----------------------ChatList------------------------//
  const ChatListUser1 = await chatService.getMyChatList(user1.toString(), {})

  const ChatListUser2 = await chatService.getMyChatList(user2.toString(), {})

  const user1Chat = 'chat-list::' + user1

  const user2Chat = 'chat-list::' + user2

  io.emit(user1Chat, ChatListUser1)
  io.emit(user2Chat, ChatListUser2)

  sendResponse(res, {
    code: 200,
    message: 'Message seen successfully',
    data: result,
  })
})

// Delete message
const deleteMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.deleteMessages(req.params.id as string)
  sendResponse(res, {
    code: 200,
    message: 'Message deleted successfully',
    data: result,
  })
})

// delete messages by chat ID
const deleteMessagesByChatId = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.deleteMessagesByChatId(req.params.chatId as string)

  sendResponse(res, {
    code: 200,
    message: 'Messages deleted successfully',
    data: result,
  })
})

export const messagesController = {
  createMessages,
  getMessagesByChatId,
  getMessagesById,
  updateMessages,
  deleteMessages,
  seenMessage,
  deleteMessagesByChatId
}
