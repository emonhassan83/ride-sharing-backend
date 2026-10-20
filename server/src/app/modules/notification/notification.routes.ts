import { Router } from 'express';
import auth from '../../middlewares/auth';
import { NotificationControllers } from './notification.controllers';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

router.post('/', NotificationControllers.createNotification);

router.delete(
  '/my-notifications',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  NotificationControllers.deleteAllNotifications
);

router.delete(
  '/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  NotificationControllers.deleteANotification
);

// Mark all as read
router.patch(
  '/',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  NotificationControllers.markAsDoneNotification
);

// Mark one as read by notification id
router.patch(
  '/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  NotificationControllers.markAsDoneANotification
);

router.get(
  '/',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  NotificationControllers.getAllNotifications
);

router.get(
  '/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  NotificationControllers.getANotification
);

export const NotificationRoutes = router;
