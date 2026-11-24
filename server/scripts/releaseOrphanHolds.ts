/**
 * One-off repair: card holds left authorized by the old "accept one booking →
 * auto-cancel the rider's other pending bookings" bug (removed 2026-11-24).
 *
 * That code set Passenger.status = cancelled (cancellationReason
 * 'accepted_another_ride') and nothing else: the Stripe hold stayed authorized,
 * the Booking stayed live and the Ride stayed pending.
 *
 * Usage (from server/):
 *   npx ts-node --transpile-only scripts/releaseOrphanHolds.ts            # dry run, read-only
 *   npx ts-node --transpile-only scripts/releaseOrphanHolds.ts --apply    # release + close
 *
 * --apply, per affected booking:
 *   - PaymentService.cancelAuthorizedBookingPayment (Stripe cancel if still
 *     requires_capture, payment/booking/passenger → cancelled_authorization)
 *   - booking.bookingStatus → cancelled
 *   - the Ride → cancelled, only if it is still pending with no driver and no
 *     other active rider
 * No money is captured or refunded: an authorization is only released.
 * A booking whose PaymentIntent Stripe already CAPTURED (status succeeded) is
 * never touched, only reported: that rider was charged and needs a refund
 * decision.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { Passenger } from '../src/app/modules/passenger/passenger.model';
import { Booking } from '../src/app/modules/booking/booking.model';
import { Payment } from '../src/app/modules/payment/payment.model';
import { Ride } from '../src/app/modules/ride/ride.model';
import { PaymentService } from '../src/app/modules/payment/payment.service';

const APPLY = process.argv.includes('--apply');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
const HOLD_STATUSES = ['authorized', 'requires_reauthorization'] as const;

const main = async () => {
  const url = process.env.MONGODB_URL;
  if (!url) throw new Error('MONGODB_URL is not set');
  await mongoose.connect(url);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (read-only)'}\n`);

  const passengers = await Passenger.find({
    status: 'cancelled',
    cancellationReason: 'accepted_another_ride',
  })
    .select('_id userId rideId departureDate departureTime')
    .lean();

  let affected = 0;
  const capturedList: string[] = [];
  for (const p of passengers as any[]) {
    const booking: any = await Booking.findOne({ passengerId: p._id }).lean();
    if (!booking) continue;
    const payment: any = await Payment.findOne({
      booking: booking._id,
      status: { $in: [...HOLD_STATUSES] as any },
    }).lean();
    if (!payment) continue;

    affected++;
    const ride: any = p.rideId ? await Ride.findById(p.rideId).lean() : null;

    // The DB can say "authorized" while Stripe already captured the money.
    // Releasing would then only relabel the booking and hide the charge.
    let piStatus = 'no PI';
    if (payment.paymentIntentId) {
      try {
        piStatus = (await stripe.paymentIntents.retrieve(payment.paymentIntentId)).status;
      } catch (e: any) {
        piStatus = `error: ${e.message}`;
      }
    }
    const captured = piStatus === 'succeeded';
    if (captured) capturedList.push(booking.id);

    console.log(
      `• booking ${booking.id} (${booking._id}) | passenger ${p._id} | ` +
        `pickup ${p.departureDate} ${p.departureTime} | €${payment.amount ?? payment.authorizedAmount ?? '?'} ` +
        `(DB ${payment.status}, Stripe ${piStatus}) | ride ${ride?.id || p.rideId} = ${ride?.status ?? 'missing'}` +
        (captured ? '  ⚠️ CAPTURED: rider was charged, needs a refund decision, NOT touched' : ''),
    );

    if (!APPLY || captured || piStatus.startsWith('error')) continue;

    const released = await PaymentService.cancelAuthorizedBookingPayment(String(booking._id));
    await Booking.updateOne({ _id: booking._id }, { $set: { bookingStatus: 'cancelled' } });

    let rideClosed = false;
    if (ride && ride.status === 'pending' && !ride.driverId) {
      const othersActive = await Passenger.countDocuments({
        rideId: ride._id,
        _id: { $ne: p._id },
        status: { $nin: ['cancelled', 'rejected'] },
      });
      if (othersActive === 0) {
        await Ride.updateOne(
          { _id: ride._id, status: 'pending' },
          {
            $set: {
              status: 'cancelled',
              cancellationReason: 'orphaned_by_auto_cancel_bug',
              cancelledAt: new Date(),
            },
          },
        );
        rideClosed = true;
      }
    }
    console.log(`    → hold released: ${released} | ride closed: ${rideClosed}`);
  }

  console.log(
    `\n${affected} booking(s) left by the bug.` +
      (APPLY ? ' Applied (captured ones skipped).' : ' Nothing changed (dry run). Re-run with --apply.'),
  );
  if (capturedList.length) {
    console.log(`⚠️ Captured in Stripe (refund decision needed, untouched): ${capturedList.join(', ')}`);
  }
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
