// jobs/jobScheduler.ts
import cron from 'node-cron';
import { batchInsertLocationHistory } from './locationHistory.job';
import { checkNoDriverFound } from './noDriverFound.job';
import { checkNoShowPassengers } from './noShowPassengers.job';
import { syncDriverLocationsToDb } from './driverLocationSync.job';
import { checkSplitFareLock } from './splitFareLock.job';
import { checkSplitRidePendingMatches } from './splitRidePendingMatch.job';
import { getRideTimeZone } from '../utils/rideSchedule.utils';

let locationJobRunning = false;
let noDriverJobRunning = false;
let noShowJobRunning = false;
let locationSyncJobRunning = false;
let splitFareLockJobRunning = false;
let splitRidePendingMatchJobRunning = false;

export function startBackgroundJobs() {
  const timezone = getRideTimeZone();
  console.log(`🕒 Starting background jobs (TIME_ZONE: ${timezone})...`);

  // 1. Location history (every 2 min)
  cron.schedule(
    '*/2 * * * *',
    async () => {
      if (locationJobRunning) return;
      locationJobRunning = true;
      try {
        await batchInsertLocationHistory();
      } catch (err) {
        console.error('❌ Location job error:', err);
      } finally {
        locationJobRunning = false;
      }
    },
    { timezone },
  );

  // 2. No driver job (poll every 1 min; re-notify interval comes from settings)
  cron.schedule(
    '* * * * *',
    async () => {
      if (noDriverJobRunning) return;
      noDriverJobRunning = true;
      try {
        await checkNoDriverFound();
      } catch (err) {
        console.error('❌ No-driver job error:', err);
      } finally {
        noDriverJobRunning = false;
      }
    },
    { timezone },
  );

  // 3. No-show job (every 30 sec)
  cron.schedule(
    '*/30 * * * * *',
    async () => {
      if (noShowJobRunning) return;
      noShowJobRunning = true;
      try {
        await checkNoShowPassengers();
      } catch (err) {
        console.error('❌ No-show job error:', err);
      } finally {
        noShowJobRunning = false;
      }
    },
    { timezone },
  );

  // 4. Split fare lock (every 30 sec)
  cron.schedule(
    '*/30 * * * * *',
    async () => {
      if (splitFareLockJobRunning) return;
      splitFareLockJobRunning = true;
      try {
        await checkSplitFareLock();
      } catch (err) {
        console.error('Split fare lock job error:', err);
      } finally {
        splitFareLockJobRunning = false;
      }
    },
    { timezone },
  );

  // 5. Split pending matching (every 1 min — needed for 1h solo fallback window)
  cron.schedule(
    '* * * * *',
    async () => {
      if (splitRidePendingMatchJobRunning) return;
      splitRidePendingMatchJobRunning = true;
      try {
        await checkSplitRidePendingMatches();
      } catch (err) {
        console.error('Split pending match job error:', err);
      } finally {
        splitRidePendingMatchJobRunning = false;
      }
    },
    { timezone },
  );

  // 6. Driver location sync (every 5 min)
  cron.schedule(
    '*/5 * * * *',
    async () => {
      if (locationSyncJobRunning) return;
      locationSyncJobRunning = true;
      try {
        await syncDriverLocationsToDb();
      } catch (err) {
        console.error('❌ Driver location sync error:', err);
      } finally {
        locationSyncJobRunning = false;
      }
    },
    { timezone },
  );

  console.log(`✅ Background jobs are now running (TIME_ZONE: ${timezone})`);
}
