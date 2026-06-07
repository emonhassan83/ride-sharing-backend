import { Router } from 'express';
import auth from '../../middlewares/auth';
import { NotificationControllers } from './notification.controllers';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

router.post('/', NotificationControllers.createNotification);

router.delete(
  '/my-notifications',
  auth('common'),
  NotificationControllers.deleteAllNotifications
);

router.delete(
  '/:id',
  auth('common'),
  NotificationControllers.deleteANotification
);

router.patch(
  '/',
  auth('common'),
  NotificationControllers.markAsDoneNotification
);

router.get('/', auth('common'), NotificationControllers.getAllNotifications);

router.get('/:id', auth('common'), NotificationControllers.getANotification);

export const NotificationRoutes = router;
