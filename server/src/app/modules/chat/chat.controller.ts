import { Request, Response } from 'express'
import catchAsync from '../../utils/catchAsync'
import sendResponse from '../../utils/sendResponse'
import { chatService } from './chat.service'

const createChat = catchAsync(async (req: Request, res: Response) => {
  const chat = await chatService.createChat(req.body)

  sendResponse(res, {
    code: 200,
    message: 'Chat created successfully',
    data: chat,
  })
})

const getMyChatList = catchAsync(async (req: Request, res: Response) => {
  const result = await chatService.getMyChatList(req.user.userId, req.query)

  sendResponse(res, {
    code: 200,
    message: 'Chat retrieved successfully',
    data: result,
  })
})

const getChatBookingById = catchAsync(async (req: Request, res: Response) => {
  const result = await chatService.getChatBookingById(req.params.bookingId as string, req.user.userId)

  sendResponse(res, {
    code: 200,
    message: 'Chat retrieved successfully',
    data: result,
  })
})

const getChatByUserId = catchAsync(async (req: Request, res: Response) => {
  const result = await chatService.getChatByUserId(req?.user.userId, req.params.userId as string)

  sendResponse(res, {
    code: 200,
    message: 'Chat retrieved successfully',
    data: result,
  })
})

const updateChat = catchAsync(async (req: Request, res: Response) => {
  const result = await chatService.updateChatList(req.params.id as string, req.body)

  sendResponse(res, {
    code: 200,
    message: 'Chat updated successfully',
    data: result,
  })
})

const deleteChat = catchAsync(async (req: Request, res: Response) => {
  const result = await chatService.deleteChatList(req.params.id as string)

  sendResponse(res, {
    code: 200,
    message: 'Chat deleted successfully',
    data: result,
  })
})

export const chatController = {
  createChat,
  getMyChatList,
  getChatByUserId,
  getChatBookingById,
  updateChat,
  deleteChat,
}
