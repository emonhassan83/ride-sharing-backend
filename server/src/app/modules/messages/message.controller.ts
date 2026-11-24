import { Request, Response } from 'express'
import catchAsync from '../../utils/catchAsync'
import { messagesService } from './message.service'
import sendResponse from '../../utils/sendResponse'
import httpStatus from 'http-status'
import { TChat } from '../chat/chat.interface'
import { chatService } from '../chat/chat.service'
import { getIO } from '../../socket/socket.init'
import ApiError from '../../errors/ApiError'

const requesterOf = (req: Request) => ({ userId: req.user.userId, role: req.user.role })

const createMessages = catchAsync(async (req: Request, res: Response) => {
  // The sender is the logged-in user, never a body field (anyone could post as
  // anyone by sending another user's id as `sender`).
  if (String(req.body?.receiver) === String(req.user.userId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'You cannot send a message to yourself')
  }
  const result = await messagesService.createMessages({
    ...req.body,
    sender: req.user.userId,
  })

  sendResponse(res, {
    code: 200,
    message: 'Message sent successfully',
    data: result,
  })
})

// Get messages by chat ID
const getMessagesByChatId = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.getMessagesByChatId(
    req.params.chatId as string,
    req.query,
    requesterOf(req),
  )

  sendResponse(res, {
    code: 200,
    message: 'Messages retrieved successfully',
    pagination: result.meta,
    data: result.data,
  })
})

// Get message by ID
const getMessagesById = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.getMessagesById(req.params.id as string, requesterOf(req))

  sendResponse(res, {
    code: 200,
    message: 'Message retrieved successfully',
    data: result,
  })
})

// Update message
const updateMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.updateMessages(req.params.id as string, req.body, requesterOf(req))

  sendResponse(res, {
    code: 200,
    message: 'Message updated successfully',
    data: result,
  })
})

//seen messages
const seenMessage = catchAsync(async (req: Request, res: Response) => {
  const chatList: TChat = await messagesService.getChatForParticipant(
    req.params.chatId as string,
    requesterOf(req),
  )

  const result = await messagesService.seenMessage(
    req.user.userId,
    req.params.chatId as string,
  )

  const user1 = chatList.participants[0]
  const user2 = chatList.participants[1]
  // //----------------------ChatList------------------------//
  const ChatListUser1 = await chatService.getMyChatList(user1.toString(), {})

  const ChatListUser2 = await chatService.getMyChatList(user2.toString(), {})

  const user1Chat = 'chat-list::' + user1

  const user2Chat = 'chat-list::' + user2

  // To the two users only: io.emit broadcast both chat lists to every socket.
  const io = getIO()
  io.to(user1.toString()).emit(user1Chat, ChatListUser1)
  io.to(user2.toString()).emit(user2Chat, ChatListUser2)

  sendResponse(res, {
    code: 200,
    message: 'Message seen successfully',
    data: result,
  })
})

// Delete message
const deleteMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.deleteMessages(req.params.id as string, requesterOf(req))
  sendResponse(res, {
    code: 200,
    message: 'Message deleted successfully',
    data: result,
  })
})

// delete messages by chat ID
const deleteMessagesByChatId = catchAsync(async (req: Request, res: Response) => {
  const result = await messagesService.deleteMessagesByChatId(req.params.chatId as string, requesterOf(req))

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
