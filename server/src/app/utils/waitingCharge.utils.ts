// utils/waitingCharge.utils.ts
import Stripe from 'stripe';
import StripeService from '../config/stripe.config';
import { User } from '../modules/user/user.model';
import { Setting } from '../modules/settings/settings.model';

export const getWaitingRatePerMinute = async (): Promise<number> => {
  const setting = await Setting.findOne({ key: 'waitingChargePerMinute' }).lean();
  return Number(setting?.value ?? 0.50);
};

export const calculateWaitingCharge = (
  waitingStartedAt: Date,
  pickedUpAt: Date,
  ratePerMinute: number,
  gracePeriodMinutes = 2,
): number => {
  const totalMinutes = (pickedUpAt.getTime() - waitingStartedAt.getTime()) / 60000;
  const billableMinutes = Math.max(0, totalMinutes - gracePeriodMinutes);
  return Math.round(billableMinutes * ratePerMinute * 100) / 100;
};

export const deductWaitingCharge = async (
  userId: string,
  amount: number,
  rideId: string,
): Promise<{ method: string; amount: number }> => {
  if (amount <= 0) return { method: 'none', amount: 0 };

  const user = await User.findById(userId).select('wallet customerId').lean();
  if (!user) return { method: 'none', amount: 0 };

  const walletBalance = user.wallet ?? 0;

  // ── Full wallet ───────────────────────────────────────────────────────────
  if (walletBalance >= amount) {
    await User.findByIdAndUpdate(userId, { $inc: { wallet: -amount } });
    return { method: 'wallet', amount };
  }

  // ── Partial wallet + card ─────────────────────────────────────────────────
  const walletPortion = walletBalance;
  const cardPortion   = amount - walletPortion;

  if (walletPortion > 0) {
    await User.findByIdAndUpdate(userId, { $inc: { wallet: -walletPortion } });
  }

  if (user.customerId && cardPortion > 0) {
    try {
      const stripe   = StripeService.getStripe();
      const customer = await stripe.customers.retrieve(user.customerId) as any;
      const defaultPM = customer.invoice_settings?.default_payment_method;

      if (defaultPM) {
        await stripe.paymentIntents.create({
          amount:   Math.round(cardPortion * 100),
          currency: 'gbp',
          customer: user.customerId,
          payment_method: defaultPM,
          confirm:  true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { rideId, type: 'waiting_charge' },
        });
      }
    } catch (err) {
      console.error('Card charge failed for waiting charge:', err);
    }
  }

  return {
    method: walletPortion > 0 ? 'wallet+card' : 'card',
    amount,
  };
};