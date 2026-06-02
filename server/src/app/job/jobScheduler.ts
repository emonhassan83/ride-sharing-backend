// jobs/jobScheduler.ts
import cron from 'node-cron';
import { batchInsertLocationHistory } from './locationHistory.job';
import { checkNoDriverFound } from './noDriverFound.job';
import { checkNoShowPassengers } from './noShowPassengers.job';

// ফ্ল্যাগ – যাতে একই জব একসাথে একাধিকবার না চলে (overlap prevention)
let locationJobRunning = false;
let noDriverJobRunning = false;
let noShowJobRunning = false;

/**
 * ব্যাকগ্রাউন্ড জবগুলো স্টার্ট করে।
 * এই ফাংশনটি সার্ভার স্টার্টআপে **একবার** কল করতে হবে।
 */
export function startBackgroundJobs() {
  console.log('🕒 Starting background jobs...');

  // 1. লোকেশন হিস্ট্রি জব (প্রতি ২ মিনিট)
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

  // 2. নো ড্রাইভার জব (প্রতি ১৫ সেকেন্ড) – ৬ ফিল্ডের cron pattern
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

  // 3. নো-শো জব (প্রতি ৩০ সেকেন্ড) – ৬ ফিল্ডের cron pattern
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

  console.log('✅ Background jobs are now running');
}