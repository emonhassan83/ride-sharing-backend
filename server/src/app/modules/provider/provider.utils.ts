import { TUser } from '../user/user.interface';
import { TProvider } from './provider.interface';
import { PROVIDER_STATUS } from './provider.constant';
import { modeType } from '../notification/notification.interface';
import { sendNotification } from '../../utils/sentPushNotification';


export const sendKycStatusNotification = async (
  verification: TProvider,
  user: TUser,
  reason?: string | null
) => {
  if (!user || !user?._id || !user?.fcmToken) return;

  const { status } = verification;

  let message: string;
  let description: string;

  switch (status) {
    case PROVIDER_STATUS.pending:
      message = '📄 KYC Verification Submitted';
      description = 'Your KYC verification documents have been received and are under review.';
      break;

    case PROVIDER_STATUS.verified:
      message = '✅ KYC Verification Approved';
      description = 'Congratulations! Your KYC verification has been successfully approved.';
      break;

    case PROVIDER_STATUS.rejected:
      message = '❌ KYC Verification Rejected';
      description = `Your KYC verification has been rejected. Reason: ${reason || 'No reason provided.'}`;
      break;

    default:
      message = 'KYC Status Update';
      description = 'Your KYC status has been updated.';
  }

  const notifyPayload = {
      receiver: user._id,
      message,
      description,
      reference: user._id,
      modelType: modeType.User,
    }
  
    await sendNotification([user.fcmToken], notifyPayload)
};