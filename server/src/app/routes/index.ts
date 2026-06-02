import express from 'express';
import { UserRoutes } from '../modules/user/user.route';
import { AuthRoutes } from '../modules/auth/auth.routes';
import { VehicleRoutes } from '../modules/vehicle/vehicle.routes';
import { ProviderRoutes } from '../modules/provider/provider.routes';
import { SettingsRoutes } from '../modules/settings/settings.routes';
import { UploadRoutes } from '../modules/upload/upload.routes';
import { NotificationRoutes } from '../modules/notification/notification.routes';
import { PaymentRoutes } from '../modules/payment/payment.routes';
import { SupportRoutes } from '../modules/support/support.routes';
import { ReviewRoutes } from '../modules/review/review.routes';
import { otpRoutes } from '../modules/otp/otp.route';
import { FaqRoutes } from '../modules/faq/faq.route';
import { ChatRoutes } from '../modules/chat/chat.route';
import { MessagesRoutes } from '../modules/messages/messages.routes';
import { RideRoutes } from '../modules/ride/ride.routes';
import { BookingRoutes } from '../modules/booking/booking.routes';
import { StripeRoute } from '../modules/stripe/stripe.route';
import { WithdrawRoutes } from '../modules/withdraw/withdraw.route';
import { RefundRoutes } from '../modules/refund/refund.route';
import { MetaRoutes } from '../modules/meta/meta.routes';
import { UserLocationRoutes } from '../modules/savedPlaces/savedPlaces.routes';
import { RiderHistoryRoutes } from '../modules/riderHistory/riderHistory.route';
import { LocationHistoryRoutes } from '../modules/locationHistory/locationHistory.route';
import { AccountDeletionRoutes } from '../modules/accountDeletion/accountDeletion.routes';
import { PassengerRoutes } from '../modules/passenger/passenger.routes';

const router = express.Router();

const apiRoutes = [
  {
    path: '/auth',
    route: AuthRoutes,
  },
  {
    path: '/user',
    route: UserRoutes,
  },
  {
    path: '/otp',
    route: otpRoutes,
  },
  {
    path: '/provider',
    route: ProviderRoutes,
  },
  {
    path: '/vehicles',
    route: VehicleRoutes,
  },
  {
    path: '/ride',
    route: RideRoutes,
  },
  {
    path: '/passenger',
    route: PassengerRoutes,
  },
  {
    path: '/bookings',
    route: BookingRoutes,
  },
  {
    path: '/rider-histories',
    route: RiderHistoryRoutes,
  },
  {
    path: '/location-histories',
    route: LocationHistoryRoutes,
  },
  {
    path: '/supports',
    route: SupportRoutes,
  },
  {
    path: '/chats',
    route: ChatRoutes,
  },
  {
    path: '/message',
    route: MessagesRoutes,
  },
  {
    path: '/review',
    route: ReviewRoutes,
  },
  {
    path: '/payments',
    route: PaymentRoutes,
  },
  {
    path: '/stripe',
    route: StripeRoute,
  },
  {
    path: '/withdraw',
    route: WithdrawRoutes,
  },
  {
    path: '/refunds',
    route: RefundRoutes,
  },
  {
    path: '/upload',
    route: UploadRoutes,
  },
  {
    path: '/notification',
    route: NotificationRoutes,
  },
  {
    path: '/faq',
    route: FaqRoutes,
  },
  {
    path: '/setting',
    route: SettingsRoutes,
  },
  {
    path: '/save-places',
    route: UserLocationRoutes,
  },
  {
    path: '/account-deletion',
    route: AccountDeletionRoutes,
  },
  {
    path: '/meta',
    route: MetaRoutes,
  },
];

apiRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
