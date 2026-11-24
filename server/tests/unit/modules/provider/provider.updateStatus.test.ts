/**
 * Admin KYC decision (PATCH /provider/:id).
 *
 * Regression: rejecting a verified driver changed only Provider.status, so
 * User.isKycVerified stayed true and the driver kept receiving ride requests;
 * status "pending" was saved as "rejected".
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/provider/provider.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Provider: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/provider/provider.utils', () => ({
  sendKycStatusNotification: vi.fn(async () => undefined),
}));
vi.mock('@src/app/utils/queueHelper', () => ({
  getEmailQueueInstance: vi.fn(async () => ({ add: vi.fn(async () => undefined) })),
}));

import { Provider } from '@src/app/modules/provider/provider.model';
import { User } from '@src/app/modules/user/user.model';
import { ProviderService } from '@src/app/modules/provider/provider.service';
import { mockQuery, mockSession, oid } from '@tests/helpers/mongoose';

const providerId = oid().toString();
const userId = oid();

beforeEach(() => {
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession() as any);
  vi.mocked(Provider.findById).mockReturnValue(
    mockQuery({ _id: providerId, userId, status: 'verified' }) as any,
  );
  vi.mocked(Provider.findByIdAndUpdate).mockImplementation(
    (_id: any, update: any) => mockQuery({ _id: providerId, userId, ...update }) as any,
  );
  vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: userId, email: null }) as any);
});

const userUpdates = () => vi.mocked(User.updateOne).mock.calls.map((c) => [c[0], c[1]]);

describe('ProviderService.updateStatusIntoDB', () => {
  it('reject: un-verifies the driver user and records the reason', async () => {
    const result: any = await ProviderService.updateStatusIntoDB(providerId, {
      status: 'rejected',
      rejectionReason: 'License photo is unreadable',
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('License photo is unreadable');
    expect(userUpdates()).toEqual(
      expect.arrayContaining([
        [{ _id: userId }, { $set: { isKycVerified: false } }],
        [{ _id: userId, status: 'active' }, { $set: { status: 'pending' } }],
      ]),
    );
  });

  it('pending: really goes back to pending (it used to be saved as rejected)', async () => {
    const result: any = await ProviderService.updateStatusIntoDB(providerId, {
      status: 'pending',
    });

    expect(result.status).toBe('pending');
    expect(result.rejectionReason).toBeNull();
    expect(userUpdates()).toEqual(
      expect.arrayContaining([[{ _id: userId }, { $set: { isKycVerified: false } }]]),
    );
  });

  it('verify: verifies the user and does not touch it via updateOne', async () => {
    const result: any = await ProviderService.updateStatusIntoDB(providerId, {
      status: 'verified',
    });

    expect(result.status).toBe('verified');
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      userId,
      { status: 'active', isKycVerified: true },
      expect.anything(),
    );
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});
