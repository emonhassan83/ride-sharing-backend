import { TUser } from '../user/user.interface';
import { TProvider } from './provider.interface';
import { PROVIDER_STATUS } from './provider.constant';
import { modeType } from '../notification/notification.interface';
import { addNotificationJob } from '../../queues/notification.queues';


export const sendKycStatusNotification = async (
  verification: TProvider,
  user: TUser,
  reason?: string | null
) => {
  if (!user || !user?._id || !user?.fcmToken) return;

  const { status } = verification;

  let title: string;
  let message: string;

  switch (status) {
    case PROVIDER_STATUS.pending:
      title = '📄 KYC Verification Submitted';
      message = 'Your KYC verification documents have been received and are under review.';
      break;

    case PROVIDER_STATUS.verified:
      title = '✅ KYC Verification Approved';
      message = 'Congratulations! Your KYC verification has been successfully approved.';
      break;

    case PROVIDER_STATUS.rejected:
      title = '❌ KYC Verification Rejected';
      message = `Your KYC verification has been rejected. Reason: ${reason || 'No reason provided.'}`;
      break;

    default:
      title = 'KYC Status Update';
      message = 'Your KYC status has been updated.';
  }

  const jobData = {
    userId: user._id.toString(),
    fcmToken: user.fcmToken,
    title,
    message,
    data: {
      status,
      reference: verification._id,
      modelType: modeType.Provider,
      type: 'KYC_STATUS',
    },
    priority: 2 as 2, // Medium priority
  };

  try {
    await addNotificationJob(jobData);
    console.log(`📤 KYC status notification queued for user: ${user._id} | Status: ${status}`);
  } catch (error) {
    console.error('Failed to queue KYC status notification:', error);
  }
};