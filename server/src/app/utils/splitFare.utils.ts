// utils/splitFare.utils.ts
import { getRedisClient } from '../config/redis.config';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { Booking } from '../modules/booking/booking.model';
import { Payment } from '../modules/payment/payment.model';
import { PAYMENT_STATUS as PAYMENT_RECORD_STATUS } from '../modules/payment/payment.constant';
import { User } from '../modules/user/user.model';
import StripeService from '../config/stripe.config';
import { isPublicHoliday, loadFareSettings } from './fareCalculator';
import { buildPassengerFareTotals, roundMoney } from './fareMath.utils';
import { getDepartureDateTime, getRefundRestrictionHours } from './rideSchedule.utils';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { sendNotification } from './sentPushNotification';
import { modeType } from '../modules/notification/notification.interface';
import { Refund } from '../modules/refund/refund.model';
import {
  REFUND_STATUS,
  REFUND_TYPE,
} from '../modules/refund/refund.constant';

const DEFAULT_SPLIT_RIDE_MATCHED_SURCHARGE_PERCENT = 30;

// Calculate single passenger fare for split ride
export const calcSplitPassengerFare = async (
  distanceKm: number,
  requestedSeats: number,
  activeRiderCount: number,
  luggageCount: number,
  departureTime: string,
  departureDate: Date
): Promise<{
  initialCharge: number;
  totalKmCharge: number;
  luggageCharge: number;
  holidayTripCharge: number;
  surchargePercent: number;
  surchargeAmount: number;
  minimumFareApplied: boolean;
  minimumFareAmount: number;
  minimumFareAdjustment: number;
  splitSurchargePercent: number;
  splitSurchargeAmount: number;
  splitRideMatchedSurchargePercent: number;
  splitRideMatchedSurchargeAmount: number;
  fareBeforePlatformCommission: number;
  platformVatPercent: number;
  vatAmount: number;
  platformCommissionPercent: number;
  platformCommissionAmount: number;
  activeSplitPassengerCount: number;
  estimatedFare: number;
}> => {
  const s = await loadFareSettings();
  const riderCount = Math.max(Number(activeRiderCount) || 1, 1);
  const matchedSurchargePercent = Number(
    (s as any).splitRideMatchedSurchargePercent ?? DEFAULT_SPLIT_RIDE_MATCHED_SURCHARGE_PERCENT,
  );

  const baseFare = roundMoney(Number(s.baseFare || 20));
  const rideTotals = buildPassengerFareTotals({
    rideType: 'split',
    riderCount,
    rawComponentFare: baseFare,
    baseFare,
    platformVatPercent: Number(s.platformVat || 9),
    platformCommissionPercent: 0,
    splitRideMatchedSurchargePercent: matchedSurchargePercent,
  });

  const perPassengerTotal =
    riderCount >= 2
      ? roundMoney(rideTotals.totalFare / riderCount)
      : rideTotals.totalFare;
  const perPassengerSurcharge =
    riderCount >= 2
      ? roundMoney(rideTotals.splitRideMatchedSurchargeAmount / riderCount)
      : 0;
  const perPassengerBase =
    riderCount >= 2 ? roundMoney(baseFare / riderCount) : baseFare;
  const perPassengerVat =
    riderCount >= 2
      ? roundMoney(rideTotals.vatAmount / riderCount)
      : rideTotals.vatAmount;

  void distanceKm;
  void requestedSeats;
  void luggageCount;
  void departureTime;
  void departureDate;

  return {
    initialCharge: perPassengerBase,
    totalKmCharge: 0,
    luggageCharge: 0,
    holidayTripCharge: 0,
    surchargePercent: riderCount >= 2 ? matchedSurchargePercent : 0,
    surchargeAmount: perPassengerSurcharge,
    minimumFareApplied: rideTotals.minimumFareApplied,
    minimumFareAmount: baseFare,
    minimumFareAdjustment: rideTotals.minimumFareAdjustment,
    splitSurchargePercent: riderCount >= 2 ? matchedSurchargePercent : 0,
    splitSurchargeAmount: perPassengerSurcharge,
    splitRideMatchedSurchargePercent: riderCount >= 2 ? matchedSurchargePercent : 0,
    splitRideMatchedSurchargeAmount: perPassengerSurcharge,
    fareBeforePlatformCommission: perPassengerBase,
    platformVatPercent: rideTotals.platformVatPercent,
    vatAmount: perPassengerVat,
    platformCommissionPercent: 0,
    platformCommissionAmount: 0,
    activeSplitPassengerCount: riderCount,
    estimatedFare: perPassengerTotal,
  };
};

// Split fare recalculation lock
export const acquireRecalculateLock = async (
  rideId: string,
  ttl = 15
): Promise<boolean> => {
  const redis = getRedisClient();
  // ioredis expects SET options as separate arguments. Passing the
  // node-redis options object here can prevent the lock from being acquired.
  const result = await redis.set(
    `ride:recalculate:lock:${rideId}`,
    '1',
    'EX',
    ttl,
    'NX'
  );
  return result === 'OK';
};

export const releaseRecalculateLock = async (rideId: string): Promise<void> => {
  await getRedisClient().del(`ride:recalculate:lock:${rideId}`);
};

// ï¿½\u20ACï¿½\u20AC Refund to wallet (Case 26 ï¿½\u20ACï¿½ always wallet, never card) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
export const refundToWallet = async (
  userId: string,
  amount: number,
  reason: string,
  io?: any
): Promise<void> => {
  if (amount <= 0) return;
  const rounded = Math.round(amount * 100) / 100;

  await User.findByIdAndUpdate(userId, { $inc: { wallet: rounded } });
  console.log(`ðŸ’° Wallet refund â‚¬${rounded} â†’ ${userId} (${reason})`);

  const user = await User.findById(userId);
  if (user && user?.fcmToken) {
    sendNotification([user.fcmToken], {
      receiver: userId,
      message: 'Ride refund amount transfer',
      description: `â‚¬${rounded.toFixed(2)} refunded to your wallet.`,
      // reference:   rideId,
      modelType: modeType.Refund,
    }).catch((err: any) =>
      console.warn(`FCM failed for passenger ${userId}:`, err)
    );
  }
};

// ï¿½\u20ACï¿½\u20AC Charge user ï¿½\u20ACï¿½ wallet first, card fallback (Case 11) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
export const chargeUser = async (
  userId: string,
  amount: number,
  rideId: string,
  reason: string,
  io?: any
): Promise<{ success: boolean; method: string; failReason?: string }> => {
  if (amount <= 0) return { success: true, method: 'none' };

  const rounded = Math.round(amount * 100) / 100;

  // ï¿½\u20ACï¿½\u20AC Idempotency check (Case 33) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
  const redis = getRedisClient();
  const idemKey = `payment:charged:${rideId}:${userId}:${Math.round(
    rounded * 100
  )}`;
  const already = await redis.get(idemKey);
  if (already) return { success: true, method: 'already_charged' };

  const user = await User.findById(userId).select('wallet customerId').lean();
  if (!user)
    return { success: false, method: 'none', failReason: 'user_not_found' };

  const wallet = user.wallet ?? 0;

  // ï¿½\u20ACï¿½\u20AC Full wallet ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
  if (wallet >= rounded) {
    await User.findByIdAndUpdate(userId, { $inc: { wallet: -rounded } });
    await redis.set(idemKey, 'wallet', 'EX', 86400);
    io?.to(`user:${userId}`).emit('ride:payment-charged', {
      amount: rounded,
      method: 'wallet',
      reason,
    });
    return { success: true, method: 'wallet' };
  }

  // ï¿½\u20ACï¿½\u20AC Partial wallet + card ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
  const walletPortion = wallet;
  const cardPortion = Math.round((rounded - walletPortion) * 100) / 100;

  if (walletPortion > 0) {
    await User.findByIdAndUpdate(userId, { $inc: { wallet: -walletPortion } });
  }

  if (user.customerId && cardPortion > 0) {
    try {
      const stripe = StripeService.getStripe();
      const customer = (await stripe.customers.retrieve(
        user.customerId
      )) as any;
      const defaultPM = customer.invoice_settings?.default_payment_method;

      if (!defaultPM) throw new Error('no_default_card');

      await stripe.paymentIntents.create({
        amount: Math.round(cardPortion * 100),
        currency: 'eur',
        customer: user.customerId,
        payment_method: defaultPM,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { rideId, userId, reason },
      });

      const method = walletPortion > 0 ? 'wallet+card' : 'card';
      await redis.set(idemKey, method, 'EX', 86400);
      io?.to(`user:${userId}`).emit('ride:payment-charged', {
        amount: rounded,
        method,
        reason,
      });
      return { success: true, method };
    } catch (err: any) {
      // ï¿½\u20ACï¿½\u20AC Rollback wallet (Case 11) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
      if (walletPortion > 0) {
        await User.findByIdAndUpdate(userId, {
          $inc: { wallet: walletPortion },
        });
      }
      console.error(`âŒ Payment failed for ${userId}:`, err.message);
      io?.to(`user:${userId}`).emit('ride:payment-failed', {
        amount: rounded,
        reason,
        message: 'Payment failed. Please update your payment method.',
      });
      return { success: false, method: 'failed', failReason: err.message };
    }
  }

  // No card available
  if (walletPortion > 0) {
    await User.findByIdAndUpdate(userId, { $inc: { wallet: walletPortion } }); // rollback
  }
  io?.to(`user:${userId}`).emit('ride:payment-failed', {
    amount: rounded,
    reason,
    message: 'No payment method found.',
  });
  return { success: false, method: 'failed', failReason: 'no_payment_method' };
};

// ï¿½\u20ACï¿½\u20AC Main recalculate (Cases 6, 29, 30, 31) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
export const recalculateSplitFares = async (
  rideId: string,
  reason:
    | 'passenger_joined'
    | 'passenger_paid'
    | 'passenger_cancelled'
    | 'passenger_rejected',
  io?: any
): Promise<void> => {
  // ï¿½\u20ACï¿½\u20AC Acquire lock (Case 31) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
  let locked = false;
  for (let i = 0; i < 3; i++) {
    locked = await acquireRecalculateLock(rideId);
    if (locked) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!locked) {
    console.warn(`âš ï¸ Could not acquire recalculate lock for ride ${rideId}`);
    return;
  }

  try {
    const activePassengers = await Passenger.find({
      rideId,
      status: {
        $in: [
          PASSENGER_STATUS.pending,
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
      },
    }).lean();

    if (!activePassengers.length) return;

    const activeRiderCount = activePassengers.length;
    const fareSettings = await loadFareSettings();
    const newSurchargePercent = activeRiderCount >= 2
      ? Number((fareSettings as any).splitRideMatchedSurchargePercent ?? DEFAULT_SPLIT_RIDE_MATCHED_SURCHARGE_PERCENT)
      : 0;

    const ride = await Ride.findById(rideId).lean();
    if (!ride) return;
    if ((ride as any).splitFareLocked) {
      console.log(`Split fare already locked | ride: ${rideId}`);
      return;
    }

    const depDate = getDepartureDateTime(
      (ride as any).departureDate,
      (ride as any).departureTime
    );

    for (const passenger of activePassengers) {
      const newFare = await calcSplitPassengerFare(
        passenger.estimatedDistanceKm || 0,
        passenger.requestedSeats || 1,
        activeRiderCount,
        passenger.luggageCounts || 0,
        (ride as any).departureTime,
        depDate
      );

      const oldFare = passenger.estimatedFare || 0;
      const diff = Math.round((newFare.estimatedFare - oldFare) * 100) / 100;

      if (Math.abs(diff) < 0.01) continue; // Case 13 ï¿½\u20ACï¿½ ignore rounding noise

      const booking = await Booking.findOne({
        passengerId: passenger._id,
        rideId,
      });
      const payment = booking
        ? await Payment.findOne({ booking: booking._id })
        : null;
      const nextPlatformCommission =
        Math.round((Number(newFare.platformCommissionAmount || 0)) * 100) / 100;
      const nextVatAmount = Math.round((Number(newFare.vatAmount || 0)) * 100) / 100;
      const nextProviderEarning =
        Math.round((Number(newFare.estimatedFare || 0) - nextPlatformCommission) * 100) /
        100;

      if (
        payment &&
        [
          PAYMENT_RECORD_STATUS.authorized,
          PAYMENT_RECORD_STATUS.requires_reauthorization,
        ].includes(payment.status as any)
      ) {
        const authorizedAmount = Math.round(
          Number(payment.authorizedAmount || payment.amount || oldFare) * 100
        ) / 100;

        payment.amount = newFare.estimatedFare;
        payment.platformCommission = nextPlatformCommission;
        payment.providerEarning = nextProviderEarning;
        payment.amountToCapture = Math.min(newFare.estimatedFare, authorizedAmount);

        if (newFare.estimatedFare > authorizedAmount + 0.01) {
          payment.status = PAYMENT_RECORD_STATUS.requires_reauthorization;
          await Passenger.findByIdAndUpdate(passenger._id, {
            paymentStatus: PAYMENT_RECORD_STATUS.requires_reauthorization,
          });
          if (booking) {
            booking.paymentStatus = PAYMENT_RECORD_STATUS.requires_reauthorization as any;
          }
        } else {
          payment.status = PAYMENT_RECORD_STATUS.authorized;
          await Passenger.findByIdAndUpdate(passenger._id, {
            paymentStatus: PAYMENT_RECORD_STATUS.authorized,
          });
          if (booking) {
            booking.paymentStatus = PAYMENT_RECORD_STATUS.authorized as any;
          }
        }

        await payment.save();
        if (booking) {
          booking.totalFare = newFare.estimatedFare;
          booking.amountPaid = 0;
          await booking.save();
        }
      } else if (diff < 0) {
        const refundAmount = Math.abs(diff);
        const refundReason = `fare_recalculate_${reason}`;

        // Captured/legacy payments still get wallet refund for split adjustment.
        await Refund.create({
          user: passenger.userId,
          ride: rideId,
          amount: refundAmount,
          type: REFUND_TYPE.split_ride,
          reason: refundReason,
          note: `Fare automatically adjusted for split ride. Reason: ${reason}.`,
          status: REFUND_STATUS.confirmed,
        });

        await refundToWallet(
          passenger.userId.toString(),
          refundAmount,
          refundReason,
          io
        );
      } else {
        // Captured/legacy fare increase -> existing wallet/card recovery path.
        const result = await chargeUser(
          passenger.userId.toString(),
          diff,
          rideId,
          `fare_recalculate_${reason}`,
          io
        );
        if (!result.success) {
          await Passenger.findByIdAndUpdate(passenger._id, {
            paymentStatus: 'pending_recovery',
          });
        }
      }
      // Update passenger fare
      await Passenger.findByIdAndUpdate(passenger._id, {
        estimatedFare: newFare.estimatedFare,
        totalFare: newFare.estimatedFare,
        surchargePercent: newFare.surchargePercent,
        surchargeAmount: newFare.surchargeAmount,
        totalKmCharge: newFare.totalKmCharge,
        luggageCharge: newFare.luggageCharge,
        holidayTripCharge: newFare.holidayTripCharge,
      });

      // Notify passenger (Case 30)
      if (io && Math.abs(diff) >= 0.01) {
        io.to(`user:${passenger.userId}`).emit('ride:fare-adjusted', {
          rideId,
          oldFare,
          newFare: newFare.estimatedFare,
          diff,
          surchargePercent: newFare.surchargePercent,
          reason,
          message:
            diff > 0
              ? `Your fare increased by â‚¬${diff.toFixed(2)}.`
              : `You saved â‚¬${Math.abs(diff).toFixed(2)}!`,
        });
      }
    }

    // Update ride surcharge
    await Ride.findByIdAndUpdate(rideId, {
      currentSurchargePercent: newSurchargePercent,
    });
    console.log(
      `✅ Recalculated | ride: ${rideId} | reason: ${reason} | riders: ${activeRiderCount} | surcharge: ${newSurchargePercent}%`
    );
  } finally {
    await releaseRecalculateLock(rideId);
  }
};

// ï¿½\u20ACï¿½\u20AC Cancellation refund (Cases 20, 21) ï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20ACï¿½\u20AC
export const calculateCancellationRefund = async (
  paidAmount: number,
  departureTime: Date,
  rideType: 'private' | 'split'
): Promise<{
  refundAmount: number;
  platformAmount: number;
  refundReason: string;
}> => {
  if (paidAmount <= 0) {
    return {
      refundAmount: 0,
      platformAmount: 0,
      refundReason: 'no_amount_paid',
    };
  }

  const restrictionHours = await getRefundRestrictionHours(rideType);
  const now = new Date();
  const hoursBeforeDep = (departureTime.getTime() - now.getTime()) / 3600000;

  if (hoursBeforeDep < 0) {
    return {
      refundAmount: 0,
      platformAmount: paidAmount,
      refundReason: 'cancelled_after_departure',
    };
  }

  if (hoursBeforeDep <= restrictionHours) {
    return {
      refundAmount: 0,
      platformAmount: paidAmount,
      refundReason: `${rideType}_refund_restricted_${restrictionHours}h_before_pickup`,
    };
  }

  return {
    refundAmount: paidAmount,
    platformAmount: 0,
    refundReason: 'outside_refund_restriction_window',
  };
};
export const transferRideOwnership = async (
  rideId: string,
  cancelledUserId: string,
  io?: any
): Promise<boolean> => {
  const remaining = await Passenger.find({
    rideId,
    userId: { $ne: cancelledUserId },
    status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
  })
    .sort({ createdAt: 1 })
    .lean();

  if (!remaining.length) return false;

  const newOwner = remaining[0];

  await Ride.findByIdAndUpdate(rideId, {
    rideCreatedBy: newOwner.userId,
    pickup: newOwner.pickup,
    destination: newOwner.destination,
  });

  const ride = await Ride.findById(rideId).select('driverId').lean();
  if (ride?.driverId && io) {
    io.to(`driver:${ride.driverId}`).emit('ride:pickup-updated', {
      rideId,
      newPickup: newOwner.pickup,
      newDestination: newOwner.destination,
      message: 'Pickup updated ï¿½\u20ACï¿½ original creator cancelled.',
    });
  }

  console.log(`âœ… Ride ${rideId} ownership â†’ user ${newOwner.userId}`);
  return true;
};


export const lockSplitRideFare = async (
  rideId: string,
  reason: 'departure_time' | 'trip_start',
  io?: any
): Promise<boolean> => {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.type !== 'split') return false;
  if ((ride as any).splitFareLocked) return true;

  await recalculateSplitFares(rideId, 'passenger_joined', io);

  const lockedRide = await Ride.findOneAndUpdate(
    { _id: rideId, splitFareLocked: { $ne: true } },
    {
      splitFareLocked: true,
      splitFareLockedAt: new Date(),
      splitFareLockReason: reason,
    },
    { returnDocument: 'after' }
  );

  if (lockedRide && io) {
    io.to(`ride:${rideId}`).emit('ride:split-fare-locked', {
      rideId,
      reason,
      lockedAt: lockedRide.splitFareLockedAt,
      message: 'Split ride fare has been finalized.',
    });
  }

  return Boolean(lockedRide || (ride as any).splitFareLocked);
};













