// utils/splitFare.utils.ts
import { getRedisClient } from '../config/redis.config';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';
import { Setting } from '../modules/settings/settings.model';
import StripeService from '../config/stripe.config';
import { isPublicHoliday, loadFareSettings } from './fareCalculator';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { sendNotification } from './sentPushNotification';
import { modeType } from '../modules/notification/notification.interface';
import { Refund } from '../modules/refund/refund.model';
import {
  REFUND_STATUS,
  REFUND_TYPE,
} from '../modules/refund/refund.constant';

// ── Surcharge based on total seats ────────────────────────────────────────────
export const getSurchargeMultiplier = (
  totalSeats: number
): { multiplier: number; percent: number } => {
  if (totalSeats >= 6) return { multiplier: 1.4, percent: 40 };
  if (totalSeats >= 5) return { multiplier: 1.2, percent: 20 };
  return { multiplier: 1.0, percent: 0 };
};

// ── Calculate single passenger fare for split ride ────────────────────────────
export const calcSplitPassengerFare = async (
  distanceKm: number,
  requestedSeats: number,
  totalSeats: number,
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
  estimatedFare: number;
}> => {
  const s = await loadFareSettings();
  const [hour] = departureTime.split(':').map(Number);
  const isNight = hour >= 20 || hour < 6;
  const isHoliday = await isPublicHoliday(departureDate);

  const initial = isNight ? s.nightFareInitialCharge : s.dayFareInitialCharge;
  const perKm = isNight ? s.nightFarePerKMRate : s.dayFarePerKMRate;
  const kmCharge = Math.round(distanceKm * perKm * 100) / 100;
  const lugCharge = Math.round(luggageCount * s.perLuggageCharge * 100) / 100;
  const holCharge = isHoliday
    ? Math.round(
        (initial + kmCharge + lugCharge) *
          (s.holidayIncreasePercentage / 100) *
          100
      ) / 100
    : 0;

  const { multiplier, percent } = getSurchargeMultiplier(totalSeats);

  const basePerSeat =
    ((initial + kmCharge + lugCharge + holCharge) / totalSeats) *
    requestedSeats;
  const surchargeAmount =
    Math.round(basePerSeat * (multiplier - 1) * 100) / 100;
  const estimatedFare = Math.round(basePerSeat * multiplier * 100) / 100;

  return {
    initialCharge:
      Math.round((initial / totalSeats) * requestedSeats * 100) / 100,
    totalKmCharge:
      Math.round((kmCharge / totalSeats) * requestedSeats * 100) / 100,
    luggageCharge:
      Math.round((lugCharge / totalSeats) * requestedSeats * 100) / 100,
    holidayTripCharge:
      Math.round((holCharge / totalSeats) * requestedSeats * 100) / 100,
    surchargePercent: percent,
    surchargeAmount,
    estimatedFare,
  };
};

// ── Redis distributed lock (Case 31) ─────────────────────────────────────────
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

// ── Refund to wallet (Case 26 — always wallet, never card) ───────────────────
export const refundToWallet = async (
  userId: string,
  amount: number,
  reason: string,
  io?: any
): Promise<void> => {
  if (amount <= 0) return;
  const rounded = Math.round(amount * 100) / 100;

  await User.findByIdAndUpdate(userId, { $inc: { wallet: rounded } });
  console.log(`💰 Wallet refund £${rounded} → ${userId} (${reason})`);

  const user = await User.findById(userId);
  if (user && user?.fcmToken) {
    sendNotification([user.fcmToken], {
      receiver: userId,
      message: 'Ride refund amount transfer',
      description: `£${rounded.toFixed(2)} refunded to your wallet.`,
      // reference:   rideId,
      modelType: modeType.Refund,
    }).catch((err: any) =>
      console.warn(`FCM failed for passenger ${userId}:`, err)
    );
  }
};

// ── Charge user — wallet first, card fallback (Case 11) ──────────────────────
export const chargeUser = async (
  userId: string,
  amount: number,
  rideId: string,
  reason: string,
  io?: any
): Promise<{ success: boolean; method: string; failReason?: string }> => {
  if (amount <= 0) return { success: true, method: 'none' };

  const rounded = Math.round(amount * 100) / 100;

  // ── Idempotency check (Case 33) ───────────────────────────────────────────
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

  // ── Full wallet ───────────────────────────────────────────────────────────
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

  // ── Partial wallet + card ─────────────────────────────────────────────────
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
        currency: 'gbp',
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
      // ── Rollback wallet (Case 11) ─────────────────────────────────────────
      if (walletPortion > 0) {
        await User.findByIdAndUpdate(userId, {
          $inc: { wallet: walletPortion },
        });
      }
      console.error(`❌ Payment failed for ${userId}:`, err.message);
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

// ── Main recalculate (Cases 6, 29, 30, 31) ───────────────────────────────────
export const recalculateSplitFares = async (
  rideId: string,
  reason:
    | 'passenger_joined'
    | 'passenger_paid'
    | 'passenger_cancelled'
    | 'passenger_rejected',
  io?: any
): Promise<void> => {
  // ── Acquire lock (Case 31) ────────────────────────────────────────────────
  let locked = false;
  for (let i = 0; i < 3; i++) {
    locked = await acquireRecalculateLock(rideId);
    if (locked) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!locked) {
    console.warn(`⚠️ Could not acquire recalculate lock for ride ${rideId}`);
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

    const totalSeats = activePassengers.reduce(
      (s, p) => s + (p.requestedSeats || 1),
      0
    );
    const { percent: newSurchargePercent } = getSurchargeMultiplier(totalSeats);

    const ride = await Ride.findById(rideId).lean();
    if (!ride) return;

    const depDate = new Date(
      `${(ride as any).departureDate}T${(ride as any).departureTime}:00`
    );

    for (const passenger of activePassengers) {
      const newFare = await calcSplitPassengerFare(
        passenger.estimatedDistanceKm || 0,
        passenger.requestedSeats || 1,
        totalSeats,
        passenger.luggageCounts || 0,
        (ride as any).departureTime,
        depDate
      );

      const oldFare = passenger.estimatedFare || 0;
      const diff = Math.round((newFare.estimatedFare - oldFare) * 100) / 100;

      if (Math.abs(diff) < 0.01) continue; // Case 13 — ignore rounding noise

      if (diff < 0) {
        const refundAmount = Math.abs(diff);
        const refundReason = `fare_recalculate_${reason}`;

        // 1. Create Refund record for split ride adjustment
        await Refund.create({
          user: passenger.userId,
          ride: rideId,
          amount: refundAmount,
          type: REFUND_TYPE.split_ride,
          reason: refundReason,
          note: `Fare automatically adjusted for split ride. Reason: ${reason}.`,
          status: REFUND_STATUS.confirmed,
        });

        // 2. Add the amount to the user's wallet
        await refundToWallet(
          passenger.userId.toString(),
          refundAmount,
          refundReason,
          io
        );
      } else {
        // Fare increased → charge (Case 30)
        const result = await chargeUser(
          passenger.userId.toString(),
          diff,
          rideId,
          `fare_recalculate_${reason}`,
          io
        );
        if (!result.success) {
          // Case 11 — flag for manual recovery
          await Passenger.findByIdAndUpdate(passenger._id, {
            paymentStatus: 'pending_recovery',
          });
        }
      }

      // Update passenger fare
      await Passenger.findByIdAndUpdate(passenger._id, {
        estimatedFare: newFare.estimatedFare,
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
              ? `Your fare increased by £${diff.toFixed(2)}.`
              : `You saved £${Math.abs(diff).toFixed(2)}!`,
        });
      }
    }

    // Update ride surcharge
    await Ride.findByIdAndUpdate(rideId, {
      currentSurchargePercent: newSurchargePercent,
    });
    console.log(
      `✅ Recalculated | ride: ${rideId} | reason: ${reason} | seats: ${totalSeats} | surcharge: ${newSurchargePercent}%`
    );
  } finally {
    await releaseRecalculateLock(rideId);
  }
};

// ── Cancellation refund (Cases 20, 21) ────────────────────────────────────────
export const calculateCancellationRefund = async (
  paidAmount: number,
  bookingTime: Date,
  departureTime: Date
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

  const settings = await Setting.find({
    key: {
      $in: ['cancellationFreeWindowHours', 'cancellationPercentage50Hours'],
    },
  }).lean();

  const map: Record<string, number> = {};
  for (const s of settings) map[s.key] = Number(s.value);

  const freeWindowHours = map.cancellationFreeWindowHours ?? 2;
  const penalty50Hours = map.cancellationPercentage50Hours ?? 24;

  const now = new Date();
  const hoursSinceBook = (now.getTime() - bookingTime.getTime()) / 3600000;
  const hoursBeforeDep = (departureTime.getTime() - now.getTime()) / 3600000;

  // Case 1: Cancellation AFTER departure time (no refund)
  if (hoursBeforeDep < 0) {
    return {
      refundAmount: 0,
      platformAmount: paidAmount,
      refundReason: 'cancelled_after_departure',
    };
  }

  // Case 2: Free cancellation window after booking
  if (hoursSinceBook <= freeWindowHours) {
    return {
      refundAmount: paidAmount,
      platformAmount: 0,
      refundReason: 'free_window',
    };
  }

  // Case 3: 50% penalty if cancelled close to departure
  if (hoursBeforeDep <= penalty50Hours) {
    const refund = Math.round(paidAmount * 0.5 * 100) / 100;
    return {
      refundAmount: refund,
      platformAmount: paidAmount - refund,
      refundReason: 'penalty_50',
    };
  }

  // Case 4: Full refund if cancelled outside the penalty window
  return {
    refundAmount: paidAmount,
    platformAmount: 0,
    refundReason: 'outside_penalty_window',
  };
};

// ── Transfer ride ownership (Case 3) ─────────────────────────────────────────
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
      message: 'Pickup updated — original creator cancelled.',
    });
  }

  console.log(`✅ Ride ${rideId} ownership → user ${newOwner.userId}`);
  return true;
};
