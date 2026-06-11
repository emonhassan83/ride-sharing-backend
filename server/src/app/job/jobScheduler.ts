// jobs/jobScheduler.ts
import cron from 'node-cron';
import { batchInsertLocationHistory } from './locationHistory.job';
import { checkNoDriverFound } from './noDriverFound.job';
import { checkNoShowPassengers } from './noShowPassengers.job';
import { syncDriverLocationsToDb } from './driverLocationSync.job';

let locationJobRunning    = false;
let noDriverJobRunning    = false;
let noShowJobRunning      = false;
let locationSyncJobRunning = false;

export function startBackgroundJobs() {
  console.log('🕒 Starting background jobs...');

  // 1. Location history job (every 2 min)
  cron.schedule('*/2 * * * *', async () => {
    if (locationJobRunning) return;
    locationJobRunning = true;
    try {
      await batchInsertLocationHistory();
    } catch (err) {
      console.error('❌ Location job error:', err);
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
      console.error('❌ No-driver job error:', err);
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
      console.error('❌ No-show job error:', err);
    } finally {
      noShowJobRunning = false;
    }
  });

  // 4. Driver location sync Redis → DB (every 5 min)
  cron.schedule('*/5 * * * *', async () => {
    if (locationSyncJobRunning) return;
    locationSyncJobRunning = true;
    try {
      await syncDriverLocationsToDb();
    } catch (err) {
      console.error('❌ Driver location sync error:', err);
    } finally {
      locationSyncJobRunning = false;
    }
  });

  console.log('✅ Background jobs are now running');
}