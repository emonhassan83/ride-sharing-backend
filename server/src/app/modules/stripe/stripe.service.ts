import httpStatus from 'http-status';
import { User } from '../user/user.model';
import StripeService from '../../config/stripe.config';
import ApiError from '../../errors/ApiError';
import { config } from '../../config/env.config';

// Create Stripe Express account and return onboarding link
const stripLinkAccount = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  try {
    const account = await StripeService.getStripe().accounts.create({
      type: 'express',
      country: 'US',
      email: user.email, // Important: Add email
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    const accountId = account.id;

    const refresh_url = `${config.server.url}/stripe/refresh/${accountId}?userId=${user._id}`;
    const return_url = `${config.server.url}/stripe/return?userId=${user._id}&stripeAccountId=${accountId}&success=true&statusCode=${httpStatus.OK}`;

    const accountLink = await StripeService.connectAccount(
      return_url,
      refresh_url,
      accountId
    );

    return accountLink.url;
  } catch (error: any) {
    if (error.code === 'platform_profile_incomplete') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Stripe platform profile incomplete. Please accept responsibilities in Stripe dashboard.'
      );
    }
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      error.message || 'Failed to create Stripe account'
    );
  }
};

// ================== Connect Existing Stripe Account ==================
const connectExistingStripeAccount = async (
  userId: string,
  payload: { stripeAccountId: string }
) => {
  const { stripeAccountId } = payload;

  if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Invalid Stripe Account ID. It must start with "acct_"'
    );
  }

  // Verify that the Stripe Account really exists
  try {
    await StripeService.getStripe().accounts.retrieve(stripeAccountId);
  } catch (err: any) {
    console.error('Stripe Account Verification Failed:', err.message);
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This Stripe account does not exist or is not accessible.'
    );
  }

  // Save to database
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { stripeAccountId },
    { new: true }
  );

  if (!updatedUser) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  // Generate onboarding / refresh link using your existing refresh logic
  const accountLinkUrl = await refresh(stripeAccountId, { userId });

  return {
    success: true,
    isNewAccount: false,
    accountId: stripeAccountId,
    url: accountLinkUrl,
    message: 'Your existing Stripe account has been successfully connected!',
  };
};

// Check if user has connected Stripe account
const checkStripeConnected = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  return {
    isConnected: !!user.stripeAccountId,
    stripeAccountId: user.stripeAccountId || null,
  };
};

// Handle Stripe OAuth callback and save connected account ID
const handleStripeOAuth = async (
  query: Record<string, any>,
  userId: string
) => {
  const { code } = query;

  if (!code) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'No authorization code received from Stripe'
    );
  }

  try {
    const response = await StripeService.getStripe().oauth.token({
      grant_type: 'authorization_code',
      code: code as string,
    });

    const connectedAccountId = response.stripe_user_id;

    if (!connectedAccountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No stripe_user_id received');
    }

    await User.findByIdAndUpdate(userId, {
      stripeAccountId: connectedAccountId,
    });

    return { success: true, stripeAccountId: connectedAccountId };
  } catch (error: any) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      error.message || 'Failed to connect Stripe account'
    );
  }
};

// Generate refresh link for stuck onboarding
const refresh = async (accountId: string, query: Record<string, any>) => {
  const userId = query.userId as string;

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const refresh_url = `${config.server.url}/stripe/refresh/${accountId}?userId=${userId}`;
  const return_url = `${config.server.url}/stripe/return?userId=${userId}&stripeAccountId=${accountId}&success=true&statusCode=${httpStatus.OK}`;

  const accountLink = await StripeService.connectAccount(
    return_url,
    refresh_url,
    accountId
  );

  return accountLink.url;
};

const returnUrl = async (query: Record<string, any>) => {
  const userId = query.userId as string;
  const stripeAccountId = query.stripeAccountId as string;

  if (!userId || !stripeAccountId) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Missing userId or stripeAccountId'
    );
  }

  return {
    stripeAccountId: stripeAccountId,
  };
};

// Step 6: Disconnect Stripe account (optional)
const disconnectStripe = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  if (!user.stripeAccountId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No Stripe account connected');
  }

  // Note: Stripe doesn't allow programmatic account deletion
  // @ts-ignore
  user.stripeAccountId = null;
  await user.save();

  return {
    success: true,
    message: 'Stripe account disconnected successfully',
  };
};

export const stripeService = {
  stripLinkAccount,
  connectExistingStripeAccount,
  checkStripeConnected,
  handleStripeOAuth,
  refresh,
  returnUrl,
  disconnectStripe,
};
