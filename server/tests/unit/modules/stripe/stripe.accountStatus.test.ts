/**
 * GET /stripe/account-status: tells the driver app whether payouts work, not
 * only whether an account id is stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockQuery } from '@tests/helpers/mongoose';

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});

// Stripe client: plain getter (not vi.fn) so mockReset cannot strip it.
const stripe = vi.hoisted(() => ({
  accounts: { retrieve: vi.fn() },
}));
vi.mock('@src/app/config/stripe.config', () => ({
  default: { getStripe: () => stripe },
}));

import { User } from '@src/app/modules/user/user.model';
import { stripeService } from '@src/app/modules/stripe/stripe.service';

describe('getStripeAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports not connected without calling Stripe when no account is stored', async () => {
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: 'u1', isDeleted: false, stripeAccountId: null }) as any,
    );
    const result = await stripeService.getStripeAccountStatus('u1');
    expect(result).toEqual({ isConnected: false, stripeAccountId: null });
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it('returns the payout flags of a linked account', async () => {
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: 'u1', isDeleted: false, stripeAccountId: 'acct_1' }) as any,
    );
    stripe.accounts.retrieve.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: false,
    });
    const result = await stripeService.getStripeAccountStatus('u1');
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith('acct_1');
    expect(result).toEqual({
      isConnected: true,
      stripeAccountId: 'acct_1',
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
  });

  it('rejects a deleted user', async () => {
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: 'u1', isDeleted: true }) as any,
    );
    await expect(stripeService.getStripeAccountStatus('u1')).rejects.toThrow('User not found');
  });
});
