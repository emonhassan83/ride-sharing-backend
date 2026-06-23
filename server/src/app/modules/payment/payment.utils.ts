import Stripe from 'stripe';
import { Types } from 'mongoose';
import { config } from '../../config/env.config';
import { TPayment } from './payment.interface';
import { TUser } from '../user/user.interface';
import { modeType } from '../notification/notification.interface';
import { sendNotification } from '../../utils/sentPushNotification';
import ApiError from '../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
console.log(config.server.url);

const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-05-27.dahlia',
  typescript: true,
});
interface TPayload {
  product: {
    amount: number;
    name: string;
    quantity: number;
  };
  customer:
    | {
        name: string;
        email: string;
      }
    | {};
  paymentId: string | Types.ObjectId;
}

export const createCheckoutSession = async (payload: TPayload) => {
  const { customer: customerData, product } = payload;

  // Best practice: Round to nearest cent before multiplying
  const amountInCents = Math.round((product.amount || 0) * 100);

  if (amountInCents <= 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid amount');
  }

  const customer = await stripe.customers.create({
    name: 'name' in customerData ? customerData.name : undefined,
    email: 'email' in customerData ? customerData.email : undefined,
  });

  const paymentGatewayData = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: product?.name || 'Ride Booking',
          },
          unit_amount: amountInCents,
        },
        quantity: product?.quantity || 1,
      },
    ],

    success_url: `${config.server.url}/payments/confirm-payment?sessionId={CHECKOUT_SESSION_ID}&paymentId=${payload?.paymentId}`,
    mode: 'payment',
    invoice_creation: { enabled: true },
    customer: customer.id,
    payment_method_types: ['card'],
  });

  return paymentGatewayData;
};

export const paymentNotifyToUser = async (
  type: 'SUCCESS' | 'REFUND',
  payment: TPayment,
  user: TUser
) => {
  // Define message and description based on type
  const message =
    type === 'SUCCESS' ? 'Payment was successful!' : 'Refunded complete';

  const description =
    type === 'SUCCESS'
      ? `Your payment of £${payment.amount} has been successfully processed`
      : `A refund of £${payment.amount} has been issued to your account`;

  // Create a notification entry
  const notifyPayload = {
    receiver: payment?.user,
    message,
    description,
    reference: payment._id,
    modelType: modeType.Payment,
  };

  await sendNotification([user.fcmToken], notifyPayload);
};
