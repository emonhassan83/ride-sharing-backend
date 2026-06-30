import { StatusCodes } from "http-status-codes"
import catchAsync from "../../utils/catchAsync"
import sendResponse from "../../utils/sendResponse"
import { NotificationService } from "./notification.services"

const createNotification = catchAsync(async (req, res) => {
  const result = await NotificationService.createNotificationIntoDB(req.body)

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Notification create successfully!',
    data: result,
  })
})

const sentGeneralNotification = catchAsync(async (req, res) => {
  const result = await NotificationService.sendGeneralNotificationIntoDB(
    req.body,
  )

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'General notification create successfully!',
    data: result,
  })
})

const getAllNotifications = catchAsync(async (req, res) => {
  const query = {
    ...req.query,
    receiver: req.user.userId,
  }
  const result = await NotificationService.getAllNotificationFromDB(query)

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Notifications retrieved successfully!',
    pagination: result.meta,
    data: result.result,
  })
})

const getANotification = catchAsync(async (req, res) => {
  const result = await NotificationService.getANotificationFromDB(req.params.id as string)

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Notification retrieved successfully!',
    data: result,
  })
})

const markAsDoneNotification = catchAsync(async (req, res) => {
  const result = await NotificationService.markAsDoneFromDB(req?.user?.userId)
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Notification marked as read successfully',
    data: result,
  })
})

const deleteANotification = catchAsync(async (req, res) => {
  const result = await NotificationService.deleteANotificationFromDB(
    req.params.id as string,
  )

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Notification delete successfully!',
    data: result,
  })
})

const deleteAllNotifications = catchAsync(async (req, res) => {
  const result = await NotificationService.deleteAllNotificationsFromDB(req.user.userId)

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Notifications delete successfully!',
    data: result,
  })
})

export const NotificationControllers = {
  createNotification,
  sentGeneralNotification,
  getAllNotifications,
  getANotification,
  markAsDoneNotification,
  deleteANotification,
  deleteAllNotifications
}