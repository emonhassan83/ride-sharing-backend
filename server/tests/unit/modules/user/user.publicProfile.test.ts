/**
 * GET /user/:userId privacy.
 *
 * Regression: any logged-in user got the full user + provider documents of any
 * other user (email, wallet, Stripe ids, IBAN, ID card / licence images,
 * earnings). Only the admin and the user themselves get that now.
 */
import { describe, expect, it, vi } from 'vitest';

for (const [path, name] of [
  ['@src/app/modules/user/user.model', 'User'],
  ['@src/app/modules/provider/provider.model', 'Provider'],
  ['@src/app/modules/vehicle/vehicle.model', 'Vehicle'],
  ['@src/app/modules/ride/ride.model', 'Ride'],
  ['@src/app/modules/passenger/passenger.model', 'Passenger'],
  ['@src/app/modules/notification/notification.model', 'Notification'],
  ['@src/app/modules/payment/payment.model', 'Payment'],
  ['@src/app/modules/review/review.model', 'Review'],
] as const) {
  vi.doMock(path, async () => {
    const { createModelMock } = await import('@tests/helpers/modelMock');
    return { [name]: createModelMock() };
  });
}
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn(), onlineUsers: new Map() }));

const load = async () => {
  const { User } = await import('@src/app/modules/user/user.model');
  const { Ride } = await import('@src/app/modules/ride/ride.model');
  const { Passenger } = await import('@src/app/modules/passenger/passenger.model');
  const { UserService } = await import('@src/app/modules/user/user.service');
  const { mockQuery, oidStr } = await import('@tests/helpers/mongoose');
  return { User, Ride, Passenger, UserService, mockQuery, oidStr };
};

describe('getSingleUser: public view for other users', async () => {
  const { User, Ride, Passenger, UserService, mockQuery, oidStr } = await load();
  const driverId = oidStr();
  const riderId = oidStr();

  const driverDoc = {
    _id: driverId,
    name: 'Driver D',
    role: 'provider',
    email: 'd@x.com',
    phone: '+35799111111',
    wallet: 250,
    customerId: 'cus_123',
    stripeAccountId: 'acct_123',
    fcmToken: 'tok',
    avgRating: 4.8,
    isKycVerified: true,
  };

  const arrange = (sharedRide: boolean) => {
    vi.mocked(User.findById).mockReturnValue(mockQuery(driverDoc) as any);
    vi.mocked(Ride.find).mockReturnValue(mockQuery([oidStr()]) as any);
    vi.mocked(Passenger.exists).mockReturnValue(mockQuery(sharedRide ? { _id: oidStr() } : null) as any);
  };

  it('a rider without a shared ride sees no contact, money or documents', async () => {
    arrange(false);
    const res: any = await UserService.getSingleUser(driverId, { userId: riderId, role: 'user' });

    expect(res).toMatchObject({ name: 'Driver D', avgRating: 4.8, isKycVerified: true });
    for (const key of ['email', 'phone', 'wallet', 'customerId', 'stripeAccountId', 'fcmToken', 'provider', 'totalEarning']) {
      expect(res).not.toHaveProperty(key);
    }
  });

  it('a rider who rode with the driver also sees the phone', async () => {
    arrange(true);
    const res: any = await UserService.getSingleUser(driverId, { userId: riderId, role: 'user' });

    expect(res.phone).toBe('+35799111111');
    expect(res).not.toHaveProperty('wallet');
  });
});
