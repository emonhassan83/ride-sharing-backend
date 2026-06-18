import { Router } from 'express'
import { chatController } from './chat.controller'
import { ChatValidation } from './chat.validation'
import { USER_ROLE } from '../user/user.constant'
import validateRequest from '../../utils/validateRequest'
import auth from '../../middlewares/auth'

const router = Router()

router.post(
  '/',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  validateRequest(ChatValidation.createValidation),
  chatController.createChat,
)

router.put(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  validateRequest(ChatValidation.updateValidation),
  chatController.updateChat,
)

router.delete(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  chatController.deleteChat,
)

router.get(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  chatController.getChatById,
)

router.get(
  '/booking/:bookingId',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  chatController.getChatBookingById,
)

router.get(
  '/my-chat-list',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  chatController.getMyChatList,
)

export const ChatRoutes = router
