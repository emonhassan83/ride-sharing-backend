import { TUser } from '../user/user.interface';
import { TProvider } from './provider.interface';
import { PROVIDER_STATUS } from './provider.constant';
import { modeType } from '../notification/notification.interface';
import { notifyUserPush } from '../../utils/notifyUser.utils';

/**
 * KYC decision push + in-app row: `type: KYC_STATUS`, `screen: home`,
 * `kycStatus: verified | rejected`. It used to go out as `ACCOUNT_STATUS`
 * (derived from modelType User), only when the driver had an FCM token, and
 * an FCM error inside the transaction could roll back the admin's decision.
 * notifyUserPush never throws, retries FCM and always saves the in-app row.
 */
export const sendKycStatusNotification = async (
  verification: TProvider,
  user: TUser,
  reason?: string | null
) => {
  if (!user?._id) return;

  const { status } = verification;

  let message: string;
  let description: string;

  switch (status) {
    case PROVIDER_STATUS.pending:
      message = 'KYC Verification Submitted';
      description = 'Your KYC verification documents have been received and are under review.';
      break;

    case PROVIDER_STATUS.verified:
      message = 'KYC Verification Approved';
      description = 'Congratulations! Your KYC verification has been successfully approved.';
      break;

    case PROVIDER_STATUS.rejected:
      message = 'KYC Verification Rejected';
      description = `Your KYC verification has been rejected. Reason: ${reason || 'No reason provided.'}`;
      break;

    default:
      message = 'KYC Status Update';
      description = 'Your KYC status has been updated.';
  }

  await notifyUserPush({
    userId: String(user._id),
    message,
    description,
    reference: String(user._id),
    modelType: modeType.User,
    data: {
      type: 'KYC_STATUS',
      screen: 'home',
      kycStatus: String(status || ''),
    },
  });
};
