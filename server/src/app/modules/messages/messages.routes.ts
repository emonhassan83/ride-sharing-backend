import { Router } from 'express'
import { messagesController } from './message.controller'
import { messagesValidation } from './message.validation'
import { USER_ROLE } from '../user/user.constant'
import validateRequest from '../../utils/validateRequest'
import auth from '../../middlewares/auth'

const router = Router()

router.post(
  '/send-messages',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  validateRequest(messagesValidation.sendMessageValidation),
  messagesController.createMessages,
)

router.patch(
  '/seen/:chatId',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  messagesController.seenMessage,
)

router.put(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  validateRequest(messagesValidation.updateMessageValidation),
  messagesController.updateMessages,
)

router.get('/my-messages/:bookingId', messagesController.getMessagesByBookingId)

router.delete(
  '/chat/:chatId',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  messagesController.deleteMessagesByChatId,
)

router.delete(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  messagesController.deleteMessages,
)

router.get(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  messagesController.getMessagesById,
)

export const MessagesRoutes = router
