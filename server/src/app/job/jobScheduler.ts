// jobs/jobScheduler.ts
import cron from 'node-cron';
import { batchInsertLocationHistory } from './locationHistory.job';
import { checkNoDriverFound } from './noDriverFound.job';
import { checkNoShowPassengers } from './noShowPassengers.job';
import { syncDriverLocationsToDb } from './driverLocationSync.job';

let locationJobRunning = false;
let noDriverJobRunning = false;
let noShowJobRunning = false;
let locationSyncJobRunning = false;

export function startBackgroundJobs() {
  console.log('ðŸ•’ Starting background jobs...');

  // 1. Location history (every 2 min)
  cron.schedule('*/2 * * * *', async () => {
    if (locationJobRunning) return;
    locationJobRunning = true;
    try {
      await batchInsertLocationHistory();
    } catch (err) {
      console.error('âŒ Location job error:', err);
    } finally {
      locationJobRunning = false;
    }
  });

  // 2. No driver job (every 15 sec)
  cron.schedule('*/15 * * * * *', async () => {
    if (noDriverJobRunning) return;
    noDriverJobRunning = true;
    try {
      await checkNoDriverFound();
    } catch (err) {
      console.error('âŒ No-driver job error:', err);
    } finally {
      noDriverJobRunning = false;
    }
  });

  // 3. No-show job (every 30 sec)
  cron.schedule('*/30 * * * * *', async () => {
    if (noShowJobRunning) return;
    noShowJobRunning = true;
    try {
      await checkNoShowPassengers();
    } catch (err) {
      console.error('âŒ No-show job error:', err);
    } finally {
      noShowJobRunning = false;
    }
  });

  // 4. Driver location sync (every 5 min)
  cron.schedule('*/5 * * * *', async () => {
    if (locationSyncJobRunning) return;
    locationSyncJobRunning = true;
    try {
      await syncDriverLocationsToDb();
    } catch (err) {
      console.error('âŒ Driver location sync error:', err);
    } finally {
      locationSyncJobRunning = false;
    }
  });

  console.log('âœ… Background jobs are now running');
}

