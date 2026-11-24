/**
 * One-off backfill: providerEarning on payments of COMPLETED split rides.
 *
 * Split payments keep providerEarning = 0 until the trip completes (the payout
 * is computed per ride). Since B-06 (2026-11-23) driver:complete-trip writes
 * the ride-level payout back to each payment pro rata. Rides completed before
 * that still show €0 per payment in the admin/website.
 *
 * Same split as distributeSplitPayoutToPayments (driverCompleteTrip.handler):
 * share = payment amount / total collected; the last payment takes the
 * rounding remainder. Only Payment.providerEarning / platformCommission are
 * written. The driver wallet is NOT touched (it was credited per ride).
 *
 * Usage (from server/):
 *   npx ts-node --transpile-only scripts/backfillSplitProviderEarning.ts          # dry run
 *   npx ts-node --transpile-only scripts/backfillSplitProviderEarning.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Ride } from '../src/app/modules/ride/ride.model';
import { Booking } from '../src/app/modules/booking/booking.model';
import { Payment } from '../src/app/modules/payment/payment.model';

const APPLY = process.argv.includes('--apply');
const round = (n: number) => Math.round(Number(n || 0) * 100) / 100;

const main = async () => {
  const url = process.env.MONGODB_URL;
  if (!url) throw new Error('MONGODB_URL is not set');
  await mongoose.connect(url);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (read-only)'}\n`);

  const rides: any[] = await Ride.find({
    type: 'split',
    status: 'completed',
    driverEarningCredited: true,
    driverEarningAmount: { $gt: 0 },
  })
    .select('_id id driverId driverEarningAmount platformCommissionAmount completedAt')
    .lean();

  let ridesFixed = 0;
  let paymentsFixed = 0;
  for (const ride of rides) {
    const bookings = await Booking.find({
      rideId: ride._id,
      bookingStatus: 'completed',
      paymentStatus: 'paid',
    })
      .select('_id')
      .lean();
    const payments: any[] = await Payment.find({
      booking: { $in: bookings.map((b) => b._id) },
      provider: ride.driverId,
      status: 'paid',
      isPaid: true,
    }).sort({ _id: 1 });
    if (!payments.length) continue;

    const currentEarning = round(payments.reduce((s, p) => s + Number(p.providerEarning || 0), 0));
    if (Math.abs(currentEarning - round(ride.driverEarningAmount)) < 0.01) continue; // already right

    const total = round(
      payments.reduce(
        (s, p) => s + Number(p.amount || p.amountToCapture || p.authorizedAmount || 0),
        0,
      ),
    );
    if (total <= 0) continue;

    let earningLeft = round(ride.driverEarningAmount);
    let commissionLeft = round(ride.platformCommissionAmount || 0);
    const plan = payments.map((p, i) => {
      const isLast = i === payments.length - 1;
      const paid = Number(p.amount || p.amountToCapture || p.authorizedAmount || 0);
      const share = paid / total;
      const earning = isLast ? earningLeft : round(ride.driverEarningAmount * share);
      const commission = isLast ? commissionLeft : round((ride.platformCommissionAmount || 0) * share);
      earningLeft = round(earningLeft - earning);
      commissionLeft = round(commissionLeft - commission);
      return { p, earning, commission };
    });

    ridesFixed++;
    console.log(
      `• ride ${ride.id} | credited €${round(ride.driverEarningAmount)} | payments now €${currentEarning} → ` +
        plan.map((x) => `€${x.earning}`).join(' + '),
    );

    if (!APPLY) continue;
    for (const { p, earning, commission } of plan) {
      await Payment.updateOne(
        { _id: p._id },
        { $set: { providerEarning: earning, platformCommission: commission } },
      );
      paymentsFixed++;
    }
  }

  console.log(
    `\n${ridesFixed} split ride(s) to fix.` +
      (APPLY ? ` ${paymentsFixed} payment(s) updated.` : ' Nothing changed (dry run). Re-run with --apply.'),
  );
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
