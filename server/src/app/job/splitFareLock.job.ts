// jobs/splitFareLock.job.ts
import { RIDE_STATUS, RIDE_TYPE } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { getIO } from '../socket/socket.init';
import { getDepartureDateTime } from '../utils/rideSchedule.utils';
import { lockSplitRideFare } from '../utils/splitFare.utils';

const BATCH_SIZE = 50;

export const checkSplitFareLock = async (): Promise<void> => {
  try {
    const now = new Date();
    const todayLocal = now.toLocaleDateString('en-CA');
    const io = getIO();

    const rides = await Ride.find({
      type: RIDE_TYPE.split,
      splitFareLocked: { $ne: true },
      status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
      departureDate: { $lte: todayLocal },
    })
      .select('_id departureDate departureTime')
      .limit(BATCH_SIZE)
      .lean();

    for (const ride of rides) {
      const departureDateTime = getDepartureDateTime(
        ride.departureDate,
        ride.departureTime
      );

      if (departureDateTime.getTime() <= now.getTime()) {
        await lockSplitRideFare(ride._id.toString(), 'departure_time', io);
      }
    }
  } catch (error) {
    console.error('checkSplitFareLock error:', error);
  }
};