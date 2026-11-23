// utils/cancellationQuote.utils.ts
//
// B-04: the app's cancel dialog showed a hard-coded "20% fee within 24 hours"
// while the backend applied a different policy. This read-only quote runs the
// SAME policy function the cancel handlers use (calculateCancellationRefund),
// so the app can show the real fee before the rider confirms.
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';
import { Ride } from '../modules/ride/ride.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Booking } from '../modules/booking/booking.model';
import { Payment } from '../modules/payment/payment.model';
import { PAYMENT_STATUS } from '../modules/payment/payment.constant';
import { calculateCancellationRefund } from './splitFare.utils';
import {
  getCancellationFeePercents,
  getDepartureDateTime,
  getRefundRestrictionHours,
} from './rideSchedule.utils';
import { roundMoney } from './fareMath.utils';

export type TCancellationQuote = {
  rideId: string;
  passengerId: string;
  /** Which socket event cancels this booking right now. */
  cancelEvent: 'ride:cancel-before-accept' | 'ride:cancel-after-accept';
  paidAmount: number;
  heldAmount: number;
  feeAmount: number;
  feePercent: number;
  refundAmount: number;
  refundReason: string;
  /** wallet = captured money credited to the wallet; card_release = card hold released. */
  refundDestination: 'wallet' | 'card_release' | null;
  refundRestrictionHours: number;
  /** Until this instant the cancellation is free (ISO-8601 UTC); null if already inside the window. */
  freeCancellationUntil: string | null;
  /** When the late-cancellation fee starts to apply (ISO-8601 UTC). */
  lateFeeFrom: string;
  earlyFeePercent: number;
  lateFeePercent: number;
  departureAt: string;
};

const ACTIVE_STATUSES = [
  PASSENGER_STATUS.pending,
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
];

export const getCancellationQuote = async (params: {
  rideId: string;
  userId: string;
  passengerId?: string;
}): Promise<TCancellationQuote> => {
  const { rideId, userId, passengerId } = params;
  if (!rideId) throw new ApiError(StatusCodes.BAD_REQUEST, 'rideId is required');
  // A malformed id used to surface as a Mongoose CastError (HTTP 500).
  if (!mongoose.isValidObjectId(rideId) || (passengerId && !mongoose.isValidObjectId(passengerId))) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  const ride = await Ride.findById(rideId).select('type status departureDate departureTime').lean();
  if (!ride) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  const cancellable = [RIDE_STATUS.pending, RIDE_STATUS.accepted, RIDE_STATUS.started];
  if (!cancellable.includes(ride.status as any)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Cannot cancel at this stage');
  }

  const passenger = await Passenger.findOne({
    rideId,
    userId,
    ...(passengerId ? { _id: passengerId } : {}),
    status: { $in: ACTIVE_STATUSES },
  })
    .select('_id status')
    .lean();
  if (!passenger) throw new ApiError(StatusCodes.NOT_FOUND, 'No active booking found');

  const booking = await Booking.findOne({ passengerId: passenger._id })
    .select('_id amountPaid totalFare')
    .lean();
  const payment = booking
    ? await Payment.findOne({ booking: booking._id }).select('status amount authorizedAmount').lean()
    : null;

  const isHold =
    !!payment &&
    [PAYMENT_STATUS.authorized, PAYMENT_STATUS.requires_reauthorization].includes(
      payment.status as any,
    );
  const isPendingRide = ride.status === RIDE_STATUS.pending;
  const departureAt = getDepartureDateTime(ride.departureDate, ride.departureTime);
  const restrictionHours = await getRefundRestrictionHours(ride.type as any);
  const freeUntil = new Date(departureAt.getTime() - restrictionHours * 3600000);
  const fees = await getCancellationFeePercents();

  // Same inputs as the handlers: a card hold is released in full (nothing was
  // captured), and before acceptance everything paid is returned.
  const paidAmount = isHold ? 0 : roundMoney(Number(booking?.amountPaid || 0));
  const heldAmount = isHold
    ? roundMoney(Number(payment?.authorizedAmount || payment?.amount || 0))
    : 0;

  const policy = isPendingRide
    ? { refundAmount: paidAmount, platformAmount: 0, refundReason: 'cancel_before_accept' }
    : await calculateCancellationRefund(paidAmount, departureAt, ride.type as any);

  return {
    rideId: String(rideId),
    passengerId: String(passenger._id),
    cancelEvent: isPendingRide ? 'ride:cancel-before-accept' : 'ride:cancel-after-accept',
    paidAmount,
    heldAmount,
    feeAmount: roundMoney(policy.platformAmount),
    feePercent:
      paidAmount > 0 ? Math.round((policy.platformAmount / paidAmount) * 10000) / 100 : 0,
    refundAmount: roundMoney(policy.refundAmount),
    refundReason: isHold && !isPendingRide ? 'authorization_released' : policy.refundReason,
    refundDestination: policy.refundAmount > 0 ? 'wallet' : isHold ? 'card_release' : null,
    refundRestrictionHours: restrictionHours,
    // Only "free" when no early fee is configured; lateFeeFrom is when the late fee starts.
    freeCancellationUntil:
      fees.early === 0 && Date.now() < freeUntil.getTime() ? freeUntil.toISOString() : null,
    lateFeeFrom: freeUntil.toISOString(),
    earlyFeePercent: fees.early,
    lateFeePercent: fees.late,
    departureAt: departureAt.toISOString(),
  };
};
