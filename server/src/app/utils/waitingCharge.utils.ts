// utils/waitingCharge.utils.ts
import StripeService from '../config/stripe.config';
import { User } from '../modules/user/user.model';
import { Setting } from '../modules/settings/settings.model';

// ✅ Hourly rate থেকে per-minute rate বের করো
export const getWaitingRatePerMinute = async (isNight = false): Promise<number> => {
  const key = isNight ? 'nightFareWaitingCharge' : 'dayFareWaitingCharge';
  const setting = await Setting.findOne({ key }).lean();

  // Default: day=17, night=19 (from Cyprus fare sheet)
  const hourlyRate = Number(setting?.value ?? (isNight ? 19.0 : 17.0));

  // Convert hourly → per minute, rounded to 4 decimal places
  return Math.round((hourlyRate / 60) * 10000) / 10000;
};

// ✅ Departure time থেকে day/night detect করো
export const isNightFare = (departureTime: string): boolean => {
  const [hour] = departureTime.split(':').map(Number);
  return hour >= 20 || hour < 6;
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
  const cardPortion = amount - walletPortion;

  if (walletPortion > 0) {
    await User.findByIdAndUpdate(userId, { $inc: { wallet: -walletPortion } });
  }

  if (user.customerId && cardPortion > 0) {
    try {
      const stripe = StripeService.getStripe();
      const customer = (await stripe.customers.retrieve(user.customerId)) as any;
      const defaultPM = customer.invoice_settings?.default_payment_method;

      if (defaultPM) {
        await stripe.paymentIntents.create({
          amount: Math.round(cardPortion * 100),
          currency: 'eur',
          customer: user.customerId,
          payment_method: defaultPM,
          confirm: true,
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

