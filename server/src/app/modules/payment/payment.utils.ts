import Stripe from 'stripe';
import { Types } from 'mongoose';
import { config } from '../../config/env.config';
import { TPayment } from './payment.interface';
import { TUser } from '../user/user.interface';
import { modeType } from '../notification/notification.interface';
import { sendNotification } from '../../utils/sentPushNotification';
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
  const { customer: customerData } = payload;

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
            name: payload?.product?.name,
          },
          unit_amount: payload.product?.amount * 100,
        },
        quantity: payload.product?.quantity,
      },
    ],

    success_url: `${config.server.url}/payments/confirm-payment?sessionId={CHECKOUT_SESSION_ID}&paymentId=${payload?.paymentId}`,
    // cancel_url: config?.payment_cancel_url,
    mode: 'payment',
    // metadata: {
    //   user: JSON.stringify({
    //     paymentId: payment.id,
    //   }),
    // },
    invoice_creation: {
      enabled: true,
    },
    customer: customer.id,
    // payment_intent_data: {
    //   metadata: {
    //     payment: JSON.stringify({
    //       ...payment,
    //     }),
    //   },
    // },
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
