/**
 * Unit tests: WithdrawService (driver payout requests).
 *
 * Money rules under test:
 *  - A driver may only request <= wallet balance, one PENDING request at a time.
 *  - Requesting does NOT touch the wallet; only admin approval ("completed") debits it,
 *    atomically (`wallet >= amount` guard) inside a transaction.
 *  - Cancel never touches the wallet. Completed requests are immutable.
 *  - Any failure aborts the transaction and always ends the session.
 *
 * Pattern reference for other service tests (see tests/README.md):
 *  - models are replaced by `createModelMock()`; configure per test with `mockQuery(...)`
 *  - `mongoose.startSession` is spied to return a fake session
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/withdraw/withdraw.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Withdraw: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/provider/provider.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Provider: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Payment: createModelMock() };
});
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/withdraw/withdraw.utils', () => ({
  sendWithdrawNotify: vi.fn(async () => undefined),
}));

import { Provider } from '@src/app/modules/provider/provider.model';
import { Payment } from '@src/app/modules/payment/payment.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { Withdraw } from '@src/app/modules/withdraw/withdraw.model';
import { sendWithdrawNotify } from '@src/app/modules/withdraw/withdraw.utils';
import { WithdrawService } from '@src/app/modules/withdraw/withdraw.service';
import { freezeTime } from '@tests/helpers/time';
import {
  mockDoc,
  mockQuery,
  mockQueryError,
  mockSession,
  oid,
  type MockSession,
} from '@tests/helpers/mongoose';

let session: MockSession;

beforeEach(() => {
  session = mockSession();
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as any);
});

/** Assert the transaction was rolled back and the session released. */
const expectRolledBack = () => {
  expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  expect(session.commitTransaction).not.toHaveBeenCalled();
  expect(session.endSession).toHaveBeenCalledTimes(1);
};

describe('WithdrawService.addWithdraw', () => {
  const userId = oid().toString();

  const arrangeUser = (user: Record<string, unknown> | null) =>
    vi.mocked(User.findById).mockReturnValue(mockQuery(user) as any);

  it('creates a pending request, commits, and does NOT debit the wallet', async () => {
    arrangeUser({ _id: userId, wallet: 100, isDeleted: false });
    vi.mocked(Withdraw.findOne).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Withdraw.create).mockResolvedValue([{ _id: oid(), amount: 40, status: 'pending' }] as any);

    const result = await WithdrawService.addWithdraw({ amount: 40 }, userId);

    expect(result).toMatchObject({ amount: 40, status: 'pending' });
    expect(Withdraw.create).toHaveBeenCalledWith(
      [{ user: userId, amount: 40, status: 'pending' }],
      { session },
    );
    expect(session.startTransaction).toHaveBeenCalledTimes(1);
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(session.abortTransaction).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledTimes(1);
    // wallet is only debited when an admin completes the request
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('reads the user and pending request INSIDE the transaction session', async () => {
    const userQuery = mockQuery({ _id: userId, wallet: 100, isDeleted: false });
    const pendingQuery = mockQuery(null);
    vi.mocked(User.findById).mockReturnValue(userQuery as any);
    vi.mocked(Withdraw.findOne).mockReturnValue(pendingQuery as any);
    vi.mocked(Withdraw.create).mockResolvedValue([{ _id: oid() }] as any);

    await WithdrawService.addWithdraw({ amount: 10 }, userId);

    expect(userQuery.session).toHaveBeenCalledWith(session);
    expect(pendingQuery.session).toHaveBeenCalledWith(session);
    expect(Withdraw.findOne).toHaveBeenCalledWith({ user: userId, status: 'pending' });
  });

  it('allows withdrawing exactly the full wallet balance (boundary)', async () => {
    arrangeUser({ _id: userId, wallet: 75.5, isDeleted: false });
    vi.mocked(Withdraw.findOne).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Withdraw.create).mockResolvedValue([{ _id: oid(), amount: 75.5 }] as any);

    await expect(WithdrawService.addWithdraw({ amount: 75.5 }, userId)).resolves.toBeDefined();
    expect(session.commitTransaction).toHaveBeenCalled();
  });

  it('rejects one cent above the wallet balance with a formatted message', async () => {
    arrangeUser({ _id: userId, wallet: 100, isDeleted: false });

    await expect(WithdrawService.addWithdraw({ amount: 100.01 }, userId)).rejects.toMatchObject({
      code: 400,
      message:
        'Insufficient balance. Your current balance is €100.00, but you requested €100.01.',
    });
    expect(Withdraw.create).not.toHaveBeenCalled();
    expectRolledBack();
  });

  it.each([undefined, null, 0, NaN, -1, -50.5])(
    'rejects a non-positive / missing amount (%s) with 400',
    async (amount) => {
      arrangeUser({ _id: userId, wallet: 100, isDeleted: false });

      await expect(
        WithdrawService.addWithdraw({ amount: amount as number }, userId),
      ).rejects.toMatchObject({
        code: 400,
        message: 'Withdrawal amount must be greater than 0',
      });
      expect(Withdraw.create).not.toHaveBeenCalled();
      expectRolledBack();
    },
  );

  it('treats a missing wallet as 0 (any positive request is insufficient)', async () => {
    arrangeUser({ _id: userId, isDeleted: false });

    await expect(WithdrawService.addWithdraw({ amount: 5 }, userId)).rejects.toMatchObject({
      code: 400,
      message: 'Insufficient balance. Your current balance is €0.00, but you requested €5.00.',
    });
  });

  it('404s for an unknown user', async () => {
    arrangeUser(null);

    await expect(WithdrawService.addWithdraw({ amount: 5 }, userId)).rejects.toMatchObject({
      code: 404,
      message: 'User not found',
    });
    expectRolledBack();
  });

  it('404s for a soft-deleted user', async () => {
    arrangeUser({ _id: userId, wallet: 100, isDeleted: true });

    await expect(WithdrawService.addWithdraw({ amount: 5 }, userId)).rejects.toMatchObject({
      code: 404,
    });
    expect(Withdraw.create).not.toHaveBeenCalled();
    expectRolledBack();
  });

  it('409s when a pending request already exists (duplicate / double-tap)', async () => {
    arrangeUser({ _id: userId, wallet: 100, isDeleted: false });
    vi.mocked(Withdraw.findOne).mockReturnValue(mockQuery({ _id: oid(), status: 'pending' }) as any);

    await expect(WithdrawService.addWithdraw({ amount: 10 }, userId)).rejects.toMatchObject({
      code: 409,
      message:
        'You already have a pending withdrawal request. Please wait until it is processed.',
    });
    expect(Withdraw.create).not.toHaveBeenCalled();
    expectRolledBack();
  });

  it('aborts and rethrows when the database write fails, still ending the session', async () => {
    arrangeUser({ _id: userId, wallet: 100, isDeleted: false });
    vi.mocked(Withdraw.findOne).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Withdraw.create).mockRejectedValue(new Error('E11000 duplicate key'));

    await expect(WithdrawService.addWithdraw({ amount: 10 }, userId)).rejects.toThrow(
      'E11000 duplicate key',
    );
    expectRolledBack();
  });

  it('still ends the session when starting the transaction path fails on read', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQueryError(new Error('db down')) as any);

    await expect(WithdrawService.addWithdraw({ amount: 10 }, userId)).rejects.toThrow('db down');
    expectRolledBack();
  });
});

describe('WithdrawService.getAllWithdrawsFromDB (admin list)', () => {
  const arrangeList = (rows: unknown[] = [], total = rows.length) => {
    const q = mockQuery(rows, { total });
    vi.mocked(Withdraw.find).mockReturnValue(q as any);
    return q;
  };

  it('with no filters queries {} and applies default paging (page 1, limit 10, newest first)', async () => {
    const q = arrangeList([{ id: 'a' }], 1);

    const res = await WithdrawService.getAllWithdrawsFromDB({});

    expect(Withdraw.find).toHaveBeenCalledWith({});
    expect(q.sort).toHaveBeenCalledWith('-createdAt -_id');
    expect(q.skip).toHaveBeenCalledWith(0);
    expect(q.limit).toHaveBeenCalledWith(10);
    expect(res.result).toEqual([{ id: 'a' }]);
    expect(res.meta).toEqual({ page: 1, limit: 10, total: 1, totalPage: 1 });
  });

  it('populates the user with only public profile fields', async () => {
    const q = arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({});
    expect(q.populate).toHaveBeenCalledWith([
      { path: 'user', select: 'name profileImage phone email' },
    ]);
  });

  it('filters by status and userId', async () => {
    arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({ status: 'pending', userId: 'u-1' });
    expect(Withdraw.find).toHaveBeenCalledWith({ status: 'pending', user: 'u-1' });
  });

  it('turns dateFrom/dateTo into an inclusive UTC day range', async () => {
    arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    expect(Withdraw.find).toHaveBeenCalledWith({
      createdAt: {
        $gte: new Date('2026-03-01T00:00:00.000Z'),
        $lte: new Date('2026-03-31T23:59:59.999Z'),
      },
    });
  });

  it('supports an open-ended date range (only dateFrom)', async () => {
    arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({ dateFrom: '2026-03-01' });
    expect(Withdraw.find).toHaveBeenCalledWith({
      createdAt: { $gte: new Date('2026-03-01T00:00:00.000Z') },
    });
  });

  it('converts min/max amount query strings to numbers', async () => {
    arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({ minAmount: '10', maxAmount: '99.5' });
    expect(Withdraw.find).toHaveBeenCalledWith({ amount: { $gte: 10, $lte: 99.5 } });
  });

  it('combines every filter at once', async () => {
    arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({
      status: 'completed',
      userId: 'u-9',
      dateFrom: '2026-01-01',
      dateTo: '2026-01-02',
      minAmount: '1',
      maxAmount: '2',
    });
    expect(Withdraw.find).toHaveBeenCalledWith({
      status: 'completed',
      user: 'u-9',
      createdAt: {
        $gte: new Date('2026-01-01T00:00:00.000Z'),
        $lte: new Date('2026-01-02T23:59:59.999Z'),
      },
      amount: { $gte: 1, $lte: 2 },
    });
  });

  it('computes total pages from the real total', async () => {
    arrangeList(Array.from({ length: 10 }, (_, i) => ({ id: String(i) })), 25);
    const res = await WithdrawService.getAllWithdrawsFromDB({ page: '2', limit: '10' });
    expect(res.meta).toEqual({ page: 2, limit: 10, total: 25, totalPage: 3 });
  });

  it('searches by public withdraw id (case-insensitive regex)', async () => {
    const q = arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({ searchTerm: 'AbC' });
    expect(q.find).toHaveBeenCalledWith({
      $or: [{ id: { $regex: 'AbC', $options: 'i' } }],
    });
  });

  it('CHARACTERIZATION: an unparsable date is passed to the database as an Invalid Date (no 400 validation)', async () => {
    arrangeList();
    await WithdrawService.getAllWithdrawsFromDB({ dateFrom: 'not-a-date' });
    const filter = vi.mocked(Withdraw.find).mock.calls[0][0] as any;
    expect(Number.isNaN(filter.createdAt.$gte.getTime())).toBe(true);
  });
});

describe('WithdrawService.getMyWithdrawsFromDB (driver earnings report)', () => {
  const driverId = oid().toString();
  const rideA = oid(); // private, completed 2026-03-10
  const rideB = oid(); // private, completed 2026-03-14
  const splitRide = oid(); // split, completed 2026-03-12
  const payA = oid();
  const payB = oid();
  const bookA = oid();
  const bookB = oid();

  const privateRide = (id: ReturnType<typeof oid>, completedAt: string, extra = {}) => ({
    _id: id,
    type: 'private',
    departureDate: '2026-03-10',
    departureTime: '10:00',
    pickup: { address: 'A' },
    destination: { address: 'B' },
    completedAt: new Date(completedAt),
    ...extra,
  });

  const arrange = (opts: {
    user?: Record<string, unknown> | null;
    payments?: unknown[];
    rides?: unknown[];
    splitRides?: unknown[];
    withdraws?: unknown[];
  }) => {
    const user = opts.user === undefined ? { wallet: 123.45, isDeleted: false } : opts.user;
    vi.mocked(User.findById).mockReturnValue(mockQuery(user) as any);
    vi.mocked(Payment.find).mockReturnValue(mockQuery(opts.payments ?? []) as any);
    // Promise.all order: [private rides by ids, split rides of the driver]
    vi.mocked(Ride.find)
      .mockReturnValueOnce(mockQuery(opts.rides ?? []) as any)
      .mockReturnValueOnce(mockQuery(opts.splitRides ?? []) as any);
    vi.mocked(Withdraw.find).mockReturnValue(mockQuery(opts.withdraws ?? []) as any);
  };

  const payments = () => [
    {
      _id: payA,
      providerEarning: 37.564,
      updatedAt: new Date('2026-03-10T12:00:00Z'),
      booking: { _id: bookA, rideId: rideA, id: 'BK-A' },
    },
    {
      _id: payB,
      providerEarning: 20,
      updatedAt: new Date('2026-03-14T12:00:00Z'),
      booking: { _id: bookB, rideId: rideB, id: 'BK-B' },
    },
  ];

  it('404s for an unknown or deleted driver', async () => {
    arrange({ user: null });
    await expect(WithdrawService.getMyWithdrawsFromDB({}, driverId)).rejects.toMatchObject({
      code: 404,
      message: 'User not found',
    });

    arrange({ user: { wallet: 1, isDeleted: true } });
    await expect(WithdrawService.getMyWithdrawsFromDB({}, driverId)).rejects.toMatchObject({
      code: 404,
    });
  });

  it('returns an empty report with the wallet balance when there are no earnings', async () => {
    arrange({});
    const res = await WithdrawService.getMyWithdrawsFromDB({}, driverId);
    expect(res.result).toEqual({
      walletBalance: 123.45,
      totalEarnings: 0,
      lifetimeEarnings: 0,
      completedRideCount: 0,
      earningsList: [],
    });
    expect(res.meta).toEqual({ page: 1, limit: 10, total: 0, totalPage: 0 });
  });

  it('builds private-ride earnings (rounded to cents) joined with their payout status, newest first', async () => {
    arrange({
      payments: payments(),
      rides: [
        privateRide(rideA, '2026-03-10T12:00:00Z'),
        privateRide(rideB, '2026-03-14T12:00:00Z'),
      ],
      withdraws: [{ payment: payA, id: 'W-A', status: 'completed' }],
    });

    const { result } = await WithdrawService.getMyWithdrawsFromDB({}, driverId);

    expect(result.earningsList.map((e: any) => e.bookingReference)).toEqual(['BK-B', 'BK-A']);
    const a = result.earningsList.find((e: any) => e.bookingReference === 'BK-A')!;
    expect(a).toMatchObject({
      id: 'W-A',
      status: 'completed',
      amountEarned: 37.56, // 37.564 rounded to cents
      rideId: rideA.toString(),
      bookingId: bookA.toString(),
      paymentId: payA.toString(),
    });
    const b = result.earningsList.find((e: any) => e.bookingReference === 'BK-B')!;
    expect(b).toMatchObject({ id: null, status: null, amountEarned: 20 }); // no payout requested yet
    expect(result.totalEarnings).toBe(57.56);
    expect(result.completedRideCount).toBe(2);
    expect(result.earningsList[0]).not.toHaveProperty('reportDate'); // internal field is stripped
  });

  it('matches a payout to an earning through the booking when the payment link is absent', async () => {
    arrange({
      payments: [payments()[0]],
      rides: [privateRide(rideA, '2026-03-10T12:00:00Z')],
      withdraws: [{ booking: bookA, id: 'W-via-booking', status: 'pending' }],
    });
    const { result } = await WithdrawService.getMyWithdrawsFromDB({}, driverId);
    expect(result.earningsList[0]).toMatchObject({ id: 'W-via-booking', status: 'pending' });
  });

  it('adds split-ride earnings from the ride itself and links the payout by ride id', async () => {
    arrange({
      splitRides: [
        {
          _id: splitRide,
          id: 'R-SPLIT',
          type: 'split',
          driverEarningAmount: 25.499,
          completedAt: new Date('2026-03-12T09:00:00Z'),
          pickup: {},
          destination: {},
        },
      ],
      withdraws: [{ ride: splitRide, booking: bookA, id: 'W-S', status: 'pending' }],
    });

    const { result } = await WithdrawService.getMyWithdrawsFromDB({}, driverId);

    expect(result.earningsList).toHaveLength(1);
    expect(result.earningsList[0]).toMatchObject({
      id: 'W-S',
      status: 'pending',
      rideId: splitRide.toString(),
      paymentId: null,
      bookingId: bookA.toString(),
      bookingReference: 'R-SPLIT',
      amountEarned: 25.5,
    });
  });

  it('does not double count: a split ride found through a payment is excluded from payment-based earnings', async () => {
    arrange({
      payments: [payments()[0]],
      rides: [privateRide(rideA, '2026-03-10T12:00:00Z', { type: 'split' })],
    });
    const { result } = await WithdrawService.getMyWithdrawsFromDB({}, driverId);
    expect(result.earningsList).toEqual([]);
    expect(result.totalEarnings).toBe(0);
  });

  it('ignores payments whose booking is missing or whose ride is not completed', async () => {
    arrange({
      payments: [
        { _id: payA, providerEarning: 10, updatedAt: new Date(), booking: null },
        { ...payments()[1] }, // ride B is not in the completed-rides result
      ],
      rides: [],
    });
    const { result } = await WithdrawService.getMyWithdrawsFromDB({}, driverId);
    expect(result.earningsList).toEqual([]);
  });

  it('falls back to the payment updatedAt when the ride has no completedAt', async () => {
    arrange({
      payments: [payments()[0], payments()[1]],
      rides: [
        privateRide(rideA, '2026-03-10T12:00:00Z', { completedAt: undefined }),
        privateRide(rideB, '2026-03-01T00:00:00Z'),
      ],
    });
    const { result } = await WithdrawService.getMyWithdrawsFromDB({}, driverId);
    // A falls back to updatedAt 2026-03-10, so it sorts before B (2026-03-01)
    expect(result.earningsList.map((e: any) => e.bookingReference)).toEqual(['BK-A', 'BK-B']);
  });

  describe('pagination', () => {
    const many = () => {
      const ps = Array.from({ length: 5 }, (_, i) => ({
        _id: oid(),
        providerEarning: i + 1,
        updatedAt: new Date(2026, 2, i + 1),
        booking: { _id: oid(), rideId: oid(), id: `BK-${i}` },
      }));
      arrange({
        payments: ps,
        rides: ps.map((p) =>
          privateRide(p.booking.rideId, new Date(2026, 2, ps.indexOf(p) + 1).toISOString()),
        ),
      });
      return ps;
    };

    it('slices the list but reports totals for the whole set', async () => {
      many();
      const { meta, result } = await WithdrawService.getMyWithdrawsFromDB(
        { page: '2', limit: '2' },
        driverId,
      );
      expect(meta).toEqual({ page: 2, limit: 2, total: 5, totalPage: 3 });
      expect(result.earningsList).toHaveLength(2);
      expect(result.totalEarnings).toBe(15);
    });

    it('returns the remainder on the last page', async () => {
      many();
      const { result } = await WithdrawService.getMyWithdrawsFromDB(
        { page: 3, limit: 2 },
        driverId,
      );
      expect(result.earningsList).toHaveLength(1);
    });

    it('returns an empty page beyond the last one', async () => {
      many();
      const { result, meta } = await WithdrawService.getMyWithdrawsFromDB(
        { page: 99, limit: 2 },
        driverId,
      );
      expect(result.earningsList).toEqual([]);
      expect(meta.total).toBe(5);
    });

    it.each([
      [{ page: 0 }, 1, 10],
      [{ page: -3 }, 1, 10],
      [{ page: 'abc' }, 1, 10],
      [{ limit: 0 }, 1, 10],
      [{ limit: -5 }, 1, 1],
      [{ limit: 'x' }, 1, 10],
    ])('sanitises paging input %j -> page %i, limit %i', async (query, page, limit) => {
      many();
      const { meta } = await WithdrawService.getMyWithdrawsFromDB(query, driverId);
      expect(meta.page).toBe(page);
      expect(meta.limit).toBe(limit);
    });
  });

  describe('date filters (ride/Cyprus local time)', () => {
    beforeEach(() => freezeTime('2026-03-15T10:00:00Z')); // 12:00 in Nicosia (UTC+2)

    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0);

    const arrangeDated = () => {
      const entries = [
        { id: 'today', date: at(2026, 3, 15) },
        { id: 'yesterday', date: at(2026, 3, 14) },
        { id: 'six-days-ago', date: at(2026, 3, 9) },
        { id: 'seven-days-ago', date: at(2026, 3, 8) },
        { id: 'earlier-month', date: at(2026, 2, 20) },
      ];
      const ps = entries.map((e) => ({
        _id: oid(),
        providerEarning: 10,
        updatedAt: e.date,
        booking: { _id: oid(), rideId: oid(), id: e.id },
      }));
      arrange({
        payments: ps,
        rides: ps.map((p, i) => privateRide(p.booking.rideId, entries[i].date.toISOString())),
      });
    };

    const refsFor = async (query: Record<string, unknown>) => {
      arrangeDated();
      const { result } = await WithdrawService.getMyWithdrawsFromDB({ limit: 50, ...query }, driverId);
      return result.earningsList.map((e: any) => e.bookingReference).sort();
    };

    it('today: only rides completed today', async () => {
      expect(await refsFor({ filter: 'today' })).toEqual(['today']);
    });

    it('week: the last 7 days including today (today-6 .. today)', async () => {
      expect(await refsFor({ filter: 'week' })).toEqual(['six-days-ago', 'today', 'yesterday']);
    });

    it('month: from the 1st of the current month to now', async () => {
      expect(await refsFor({ filter: 'month' })).toEqual([
        'seven-days-ago',
        'six-days-ago',
        'today',
        'yesterday',
      ]);
    });

    it('specific_day: one calendar day', async () => {
      expect(await refsFor({ filter: 'specific_day', date: '2026-03-14T00:00:00' })).toEqual([
        'yesterday',
      ]);
    });

    it('custom: inclusive from/to, including the whole end day', async () => {
      expect(
        await refsFor({
          filter: 'custom',
          dateFrom: '2026-03-08T00:00:00',
          dateTo: '2026-03-09T00:00:00',
        }),
      ).toEqual(['seven-days-ago', 'six-days-ago']);
    });

    it('custom with only dateFrom is open-ended', async () => {
      expect(await refsFor({ filter: 'custom', dateFrom: '2026-03-14T00:00:00' })).toEqual([
        'today',
        'yesterday',
      ]);
    });

    it('unknown / empty filter returns everything', async () => {
      expect(await refsFor({ filter: 'bogus' })).toHaveLength(5);
      expect(await refsFor({})).toHaveLength(5);
    });

    it('B-06: the date filter narrows the list, ride count and totalEarnings; lifetimeEarnings stays the all-time total', async () => {
      arrangeDated();
      const { result } = await WithdrawService.getMyWithdrawsFromDB({ filter: 'today' }, driverId);
      expect(result.earningsList).toHaveLength(1);
      expect(result.completedRideCount).toBe(1);
      expect(result.totalEarnings).toBe(10); // today's ride only
      expect(result.lifetimeEarnings).toBe(50); // all five rides, regardless of the filter
    });

    it('filter name is case-insensitive', async () => {
      expect(await refsFor({ filter: 'TODAY' })).toEqual(['today']);
    });
  });
});

describe('WithdrawService.getAWithdrawFromDB', () => {
  it('returns the populated withdrawal', async () => {
    const doc = { _id: oid(), amount: 5 };
    const q = mockQuery(doc);
    vi.mocked(Withdraw.findById).mockReturnValue(q as any);

    await expect(WithdrawService.getAWithdrawFromDB('abc')).resolves.toBe(doc);
    expect(q.populate).toHaveBeenCalledWith([
      { path: 'user', select: 'name email profileImage phone' },
    ]);
  });

  it('404s when it does not exist', async () => {
    vi.mocked(Withdraw.findById).mockReturnValue(mockQuery(null) as any);
    await expect(WithdrawService.getAWithdrawFromDB('abc')).rejects.toMatchObject({
      code: 404,
      message: 'Withdraw not found',
    });
  });
});

describe('WithdrawService.updateWithdrawFromDB (admin approve / cancel)', () => {
  const userId = oid();
  const arrange = (withdraw: ReturnType<typeof mockDoc> | null) =>
    vi.mocked(Withdraw.findById).mockReturnValue(mockQuery(withdraw) as any);

  const pending = (extra: Record<string, unknown> = {}) =>
    mockDoc({
      user: userId,
      amount: 60,
      status: 'pending',
      ibanNumber: null as string | null,
      note: null as string | null,
      completedAt: null as Date | null,
      ...extra,
    });

  describe('pending -> completed', () => {
    beforeEach(() => {
      freezeTime('2026-05-01T08:30:00Z');
      vi.mocked(Provider.findOne).mockReturnValue(mockQuery({ ibanNumber: 'CY17002001280000001200527600' }) as any);
      vi.mocked(User.findOneAndUpdate).mockReturnValue(mockQuery({ _id: userId, wallet: 40 }) as any);
    });

    it('debits the wallet atomically, snapshots the IBAN, stamps completion and commits', async () => {
      const w = pending();
      arrange(w);
      vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: userId, fcmToken: 'tok' }) as any);

      const result = await WithdrawService.updateWithdrawFromDB('w1', {
        status: 'completed',
        note: 'Paid via SEPA',
      });

      // atomic guard: only debit when the balance still covers the amount
      expect(User.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: userId, wallet: { $gte: 60 } },
        { $inc: { wallet: -60 } },
        { session, returnDocument: 'after' },
      );
      expect(result.status).toBe('completed');
      expect(result.completedAt).toEqual(new Date('2026-05-01T08:30:00Z'));
      expect(result.ibanNumber).toBe('CY17002001280000001200527600');
      expect(result.note).toBe('Paid via SEPA');
      expect(w.save).toHaveBeenCalledWith({ session });
      expect(sendWithdrawNotify).toHaveBeenCalledWith('completed', w, expect.objectContaining({ fcmToken: 'tok' }));
      expect(session.commitTransaction).toHaveBeenCalledTimes(1);
      expect(session.abortTransaction).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('keeps an existing IBAN snapshot when the provider profile has none', async () => {
      const w = pending({ ibanNumber: 'OLD-IBAN' });
      arrange(w);
      vi.mocked(Provider.findOne).mockReturnValue(mockQuery(null) as any);
      vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);

      const result = await WithdrawService.updateWithdrawFromDB('w1', { status: 'completed' });
      expect(result.ibanNumber).toBe('OLD-IBAN');
      expect(result.note).toBeNull(); // no note supplied -> untouched
    });

    it('rejects with 400 and does NOT mark completed when the wallet no longer covers the amount', async () => {
      const w = pending();
      arrange(w);
      vi.mocked(User.findOneAndUpdate).mockReturnValue(mockQuery(null) as any);

      await expect(
        WithdrawService.updateWithdrawFromDB('w1', { status: 'completed' }),
      ).rejects.toMatchObject({
        code: 400,
        message: 'Insufficient wallet balance or concurrent request detected.',
      });
      expect(w.status).toBe('pending');
      expect(w.save).not.toHaveBeenCalled();
      expect(sendWithdrawNotify).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('skips the notification (but still commits) when the user record is gone', async () => {
      arrange(pending());
      vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);

      await WithdrawService.updateWithdrawFromDB('w1', { status: 'completed' });
      expect(sendWithdrawNotify).not.toHaveBeenCalled();
      expect(session.commitTransaction).toHaveBeenCalled();
    });

    // Was a DESIGN NOTE: a failing push rolled back the whole approval (500). The push now runs
    // after the commit and its failure is only logged.
    it('a failing push notification does NOT roll back the approval', async () => {
      arrange(pending());
      vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: userId, fcmToken: 't' }) as any);
      vi.mocked(sendWithdrawNotify).mockRejectedValue(new Error('FCM unavailable'));

      const result = await WithdrawService.updateWithdrawFromDB('w1', { status: 'completed' });
      expect(result.status).toBe('completed');
      expect(session.commitTransaction).toHaveBeenCalledTimes(1);
      expect(session.abortTransaction).not.toHaveBeenCalled();
      expect(sendWithdrawNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe('pending -> cancelled', () => {
    it('cancels without touching the wallet or the provider profile', async () => {
      const w = pending();
      arrange(w);
      vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: userId, fcmToken: 't' }) as any);

      const result = await WithdrawService.updateWithdrawFromDB('w1', {
        status: 'cancelled',
        note: 'Wrong IBAN',
      });

      expect(result.status).toBe('cancelled');
      expect(result.note).toBe('Wrong IBAN');
      expect(User.findOneAndUpdate).not.toHaveBeenCalled();
      expect(Provider.findOne).not.toHaveBeenCalled();
      expect(sendWithdrawNotify).toHaveBeenCalledWith('cancelled', w, expect.anything());
      expect(session.commitTransaction).toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('404s for an unknown withdrawal', async () => {
      arrange(null);
      await expect(
        WithdrawService.updateWithdrawFromDB('nope', { status: 'completed' }),
      ).rejects.toMatchObject({ code: 404, message: 'Withdraw not found' });
      expectRolledBack();
    });

    it('refuses to modify a completed withdrawal (immutable once paid)', async () => {
      const w = pending({ status: 'completed' });
      arrange(w);
      await expect(
        WithdrawService.updateWithdrawFromDB('w1', { status: 'cancelled' }),
      ).rejects.toMatchObject({ code: 400, message: 'Completed withdrawals cannot be updated' });
      expect(User.findOneAndUpdate).not.toHaveBeenCalled();
      expect(w.save).not.toHaveBeenCalled();
      expectRolledBack();
    });

    it('refuses to modify an already cancelled withdrawal', async () => {
      arrange(pending({ status: 'cancelled' }));
      await expect(
        WithdrawService.updateWithdrawFromDB('w1', { status: 'completed' }),
      ).rejects.toMatchObject({
        code: 400,
        message: 'Cannot update withdrawal from "cancelled" status.',
      });
      expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects an invalid target status (pending -> pending) without side effects', async () => {
      const w = pending();
      arrange(w);
      await expect(
        WithdrawService.updateWithdrawFromDB('w1', { status: 'pending' as any }),
      ).rejects.toMatchObject({
        code: 400,
        message: 'Invalid status transition: pending -> pending',
      });
      expect(w.save).not.toHaveBeenCalled();
      expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('hides unexpected (non-ApiError) failures behind a generic 500', async () => {
      const w = pending();
      w.save.mockRejectedValue(new Error('MongoServerError: secret internal detail'));
      arrange(w);
      vi.mocked(User.findOneAndUpdate).mockReturnValue(mockQuery({ _id: userId }) as any);
      vi.mocked(Provider.findOne).mockReturnValue(mockQuery(null) as any);

      await expect(
        WithdrawService.updateWithdrawFromDB('w1', { status: 'completed' }),
      ).rejects.toMatchObject({ code: 500, message: 'Failed to update withdraw status' });
      expectRolledBack();
    });
  });
});
