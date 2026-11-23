import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';

/**
 * Take a driver's earning for a refunded payment back out of their wallet,
 * but ONLY if it was actually credited.
 *
 * The driver wallet is credited once, at trip completion (driverCompleteTrip,
 * which sets `ride.driverEarningCredited`). `payment.providerEarning` is already
 * filled in at capture time though, so the cancel and refund paths used to debit
 * money the driver never received, pushing driver wallets negative.
 *
 * Returns the amount debited (0 when nothing was credited, so nothing to revert).
 */
export const revertDriverEarningIfCredited = async (params: {
  rideId: unknown;
  driverId: unknown;
  amount: unknown;
}): Promise<number> => {
  const amount = Math.round(Number(params.amount || 0) * 100) / 100;
  if (!params.rideId || !params.driverId || !(amount > 0)) return 0;

  const ride = await Ride.findById(params.rideId).select('driverEarningCredited').lean();
  if (!(ride as any)?.driverEarningCredited) return 0;

  await User.findByIdAndUpdate(params.driverId, { $inc: { wallet: -amount } });
  console.log(`💰 Reverted credited driver earning €${amount} | driver ${params.driverId} | ride ${params.rideId}`);
  return amount;
};
