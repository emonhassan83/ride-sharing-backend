import { Job, Worker } from 'bullmq';
import { compile } from 'handlebars';
import { requestContext } from '@/app/configs/requestContext.configs';
import { getRedisClient } from '@/app/configs/redis.configs';
import { logger } from '../configs/logger.configs';
import { sendEmail } from '../configs/nodemailer.config';
import sendKycRejectionEmail from '../templates/sendKycRejectEmailTemplete';
import sendKycSuccessEmail from '../templates/sendKycVerifiedEmailTemplete';
import sendResetPasswordEmail from '../templates/sendResetPasswordEmailTemplete';
import sendSupportReplyEmail from '../templates/sendSupportReplyEmailTemplete';
import sendVerificationEmail from '../templates/sendVeificationEmailTemplete';

export const createEmailWorker = (): Worker => {
  const EmailWorker = new Worker(
    'email-queue',
    async (job: Job) => {
      const { id, name, data } = job;
      const traceId = (job.data as any)?.traceId ?? 'NO_TRACE_ID';
      return requestContext.run({ traceId }, async () => {
        try {
          let subject = '';
          let html = '';

          switch (name) {
            case 'send-verification-email': {
              const { email, name, otp, expiresAt } = data as {
                email: string;
                name: string;
                otp: string;
                expiresAt: string;
              };
              subject = 'Your One-Time OTP';

              const template = compile(sendVerificationEmail);
              html = template({ email, name, otp, expiresAt });
              break;
            }

            case 'send-reset-password-email': {
              const { email, name, otp, expiresAt } = data as {
                email: string;
                name: string;
                otp: string;
                expiresAt: string;
              };
              subject = 'Your One-Time OTP';

              const template = compile(sendResetPasswordEmail);
              html = template({ email, name, otp, expiresAt });
              break;
            }

            case 'send-kyc-verified-email': {
              const { name, email } = data as {
                name: string;
                email: string;
              };
              subject = '✅ Your KYC Verification Has Been Approved!';

              const template = compile(sendKycSuccessEmail);
              html = template({ name, email });
              break;
            }

            case 'send-kyc-rejected-email': {
              const { name, email, reason } = data as {
                email: string;
                name: string;
                reason: string;
              };
              subject = '❌ Your KYC Verification Was Not Approved';

              const template = compile(sendKycRejectionEmail);
              html = template({ name, email, reason });
              break;
            }

            case 'send-support-reply-email': {
              const { support } = data as { support: any };
              const subj = (data as any).subj || (data as any).subject || 'Support Reply';
              const messages = (data as any).messages || (data as any).message || '';
              subject = `Support Message: ${subj}`;

              const template = compile(sendSupportReplyEmail);
              html = template({ support, subj, messages });
              break;
            }

            default:
              throw new Error(`Unhandled email job: ${name}`);
          }

          // Send email using your external service
          const recipientEmail = (data as any).email || (data as any).support?.email;
          if (!recipientEmail) {
            throw new Error('Recipient email is missing in job data');
          }
          await sendEmail({ to: recipientEmail, subject, html });
        } catch (error) {
          logger.error('Worker job failed', {
            jobName: name,
            jobId: id,
            error,
          });
          throw error;
        }
      });
    },
    { connection: getRedisClient() as any }
  );

  EmailWorker.on('completed', (job: Job) => {
    const traceId = (job.data as any)?.traceId ?? 'NO_TRACE_ID';
    requestContext.run({ traceId }, () => {
      logger.info(`Job Name : ${job.name} Job Id : ${job.id} Completed`);
    });
  });

  EmailWorker.on('failed', (job: Job | undefined, error: Error) => {
    if (!job) {
      logger.error(
        `A job failed but the job data is undefined.\nError:\n${error}`
      );
      return;
    }
    const traceId = (job.data as any)?.traceId ?? 'NO_TRACE_ID';
    requestContext.run({ traceId }, () => {
      logger.error(
        `Job Name : ${job.name} Job Id : ${job.id} Failed\nError:\n${error}`
      );
    });
  });
  return EmailWorker;
};


