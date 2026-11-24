import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Payment } from '../payment/payment.model';
import { User } from '../user/user.model';
import { Booking } from '../booking/booking.model';
import { PAYMENT_STATUS } from '../payment/payment.constant';
import { USER_ROLE, USER_STATUS } from '../user/user.constant';
import {
  BOOKING_STATUS,
  PAYMENT_STATUS as BOOKING_PAYMENT_STATUS,
} from '../booking/booking.constant';
import { Refund } from '../refund/refund.model';
import { REFUND_STATUS } from '../refund/refund.constant';

/**
 * Dashboard Meta Data Service
 */
export const fetchDashboardMetaData = async (
  query: Record<string, unknown>
) => {
  const {
    revenue_year,
    sort,
    sort_amount,
    amount_sort,
    amount,
    order,
    sortOrder,
    minAmount,
    maxAmount,
    min_amount,
    max_amount,
    limit,
    recent_limit,
  } = query;

  const currentYear = new Date().getFullYear();
  const selectedYear = revenue_year
    ? parseInt(revenue_year as string)
    : currentYear;

  // ====================== TOTAL COUNTS ======================
  const [totalUsers, totalRiders, totalDrivers, totalBookings] =
    await Promise.all([
      User.countDocuments({ isDeleted: false, role: { $ne: 'admin' } }),
      User.countDocuments({
        role: USER_ROLE.user,
        isDeleted: false,
        status: USER_STATUS.active,
      }),
      User.countDocuments({
        role: USER_ROLE.provider,
        isDeleted: false,
        status: USER_STATUS.active,
      }),
      Booking.countDocuments({}),
    ]);

  // ====================== CANCELLATIONS ======================
  // Counted over real bookings only (the card was authorized or charged at some
  // point); an abandoned unpaid booking is not a cancellation.
  const realBooking = {
    paymentStatus: { $nin: [BOOKING_PAYMENT_STATUS.pending, BOOKING_PAYMENT_STATUS.failed] },
  };
  const [cancelledBookings, completedBookings] = await Promise.all([
    Booking.countDocuments({ ...realBooking, bookingStatus: BOOKING_STATUS.cancelled }),
    Booking.countDocuments({ ...realBooking, bookingStatus: BOOKING_STATUS.completed }),
  ]);
  const finishedBookings = cancelledBookings + completedBookings;
  const cancellationRate =
    finishedBookings > 0
      ? Math.round((cancelledBookings / finishedBookings) * 10000) / 100
      : 0;

  // ====================== REFUNDS ======================
  // Payment has no refundAmount field, so the old `$sum: '$refundAmount'` on
  // payments was always 0. Every refund creates a confirmed Refund document.
  const sumRefunds = async (match: Record<string, unknown>) => {
    const [row] = await Refund.aggregate([
      { $match: { status: REFUND_STATUS.confirmed, ...match } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    return {
      total: Math.round((row?.total || 0) * 100) / 100,
      count: row?.count || 0,
    };
  };

  // ====================== FINANCIAL METRICS ======================
  const paymentPipeline = [
    {
      $match: {
        isPaid: true,
        isDeleted: false,
        status: PAYMENT_STATUS.paid,
      },
    },
    {
      $group: {
        _id: null,
        totalEarning: { $sum: '$amount' },
        totalPlatformCommission: { $sum: '$platformCommission' },
        totalProviderEarning: { $sum: '$providerEarning' },
      },
    },
  ];

  const [financialData] = await Payment.aggregate(paymentPipeline);

  // ── Determine amount sorting direction: 'asc' vs 'desc' / 'dsc' ──
  // Issue 14: "recent" = most recently paid/refunded, not most recently booked.
  let sortOption: Record<string, 1 | -1> = { updatedAt: -1, _id: -1 };

  const rawAmountSort = String(
    amount_sort || sort_amount || (typeof amount === 'string' && isNaN(Number(amount)) ? amount : '') || ''
  ).toLowerCase().trim();

  const rawSort = String(sort || '').toLowerCase().trim();
  const rawOrder = String(sortOrder || order || '').toLowerCase().trim();

  const isAsc =
    rawAmountSort === 'asc' ||
    rawSort === 'amount' ||
    rawSort === 'amount:asc' ||
    rawSort === '+amount' ||
    rawSort === 'asc' ||
    (rawSort.includes('amount') && (rawSort.includes('asc') || rawOrder === 'asc')) ||
    (rawOrder === 'asc' && (rawSort.includes('amount') || rawAmountSort === 'asc'));

  const isDesc =
    rawAmountSort === 'desc' ||
    rawAmountSort === 'dsc' ||
    rawSort === '-amount' ||
    rawSort === 'amount:desc' ||
    rawSort === 'amount:dsc' ||
    rawSort === 'desc' ||
    rawSort === 'dsc' ||
    (rawSort.includes('amount') && (rawSort.includes('desc') || rawSort.includes('dsc') || rawOrder === 'desc' || rawOrder === 'dsc')) ||
    ((rawOrder === 'desc' || rawOrder === 'dsc') && (rawSort.includes('amount') || rawAmountSort === 'desc' || rawAmountSort === 'dsc'));

  if (isAsc) {
    sortOption = { amount: 1, updatedAt: -1, _id: -1 };
  } else if (isDesc) {
    sortOption = { amount: -1, updatedAt: -1, _id: -1 };
  }

  // ── Transaction Filter Criteria ──
  const transactionFilter: Record<string, any> = {
    isDeleted: false,
    status: { $in: [PAYMENT_STATUS.paid, PAYMENT_STATUS.refunded] },
  };

  const minAmt = minAmount !== undefined ? Number(minAmount) : min_amount !== undefined ? Number(min_amount) : undefined;
  const maxAmt = maxAmount !== undefined ? Number(maxAmount) : max_amount !== undefined ? Number(max_amount) : undefined;

  if (minAmt !== undefined && !isNaN(minAmt)) {
    transactionFilter.amount = { ...(transactionFilter.amount || {}), $gte: minAmt };
  }
  if (maxAmt !== undefined && !isNaN(maxAmt)) {
    transactionFilter.amount = { ...(transactionFilter.amount || {}), $lte: maxAmt };
  }
  if (typeof amount === 'number' || (typeof amount === 'string' && !isNaN(Number(amount)) && amount.trim() !== '')) {
    transactionFilter.amount = Number(amount);
  }

  const transactionLimit = Number(limit || recent_limit) > 0 ? Number(limit || recent_limit) : 5;

  // Recent Transactions (Latest finalized: paid or refunded, sorted & filtered)
  const recentTransactions = await Payment.find(transactionFilter)
    .populate('user', 'name profileImage')
    .populate('provider', 'name')
    .populate('booking', 'id')
    .sort(sortOption)
    .limit(transactionLimit)
    .select('id method transactionId amount status createdAt updatedAt')
    .lean();

  // Sales Report Summary (Current Year paid transactions)
  const salesReport = await Payment.aggregate([
    {
      $match: {
        isDeleted: false,
        status: PAYMENT_STATUS.paid,
        isPaid: true,
        createdAt: {
          $gte: new Date(`${selectedYear}-01-01`),
          $lte: new Date(`${selectedYear}-12-31`),
        },
      },
    },
    {
      $group: {
        _id: null,
        totalIncome: { $sum: '$amount' },
        totalPlatformCommission: { $sum: '$platformCommission' },
      },
    },
  ]);

  const salesData = salesReport[0] || {
    totalIncome: 0,
    totalPlatformCommission: 0,
  };

  const [allTimeRefunds, yearRefunds] = await Promise.all([
    sumRefunds({}),
    sumRefunds({
      createdAt: {
        $gte: new Date(`${selectedYear}-01-01`),
        $lte: new Date(`${selectedYear}-12-31T23:59:59.999Z`),
      },
    }),
  ]);

  return {
    // Main Stats
    totalUsers,
    totalRiders,
    totalDrivers,
    totalBookings, // Total Rides

    // Financial Overview
    totalEarning: financialData?.totalEarning || 0,
    totalPlatformCommission: financialData?.totalPlatformCommission || 0,
    totalProviderEarning: financialData?.totalProviderEarning || 0,
    totalRefunded: allTimeRefunds.total,
    totalRefundCount: allTimeRefunds.count,

    // Cancellations (real bookings: paid or authorized at some point)
    cancelledBookings,
    completedBookings,
    cancellationRate, // % of finished bookings (cancelled + completed) that were cancelled

    // Sales Report
    salesReport: {
      totalIncome: salesData.totalIncome,
      platformCommission: salesData.totalPlatformCommission,
      refunded: yearRefunds.total,
      netIncome: Number(
        (
          (salesData.totalIncome || 0) -
          (salesData.totalPlatformCommission || 0)
        ).toFixed(2)
      ),
    },

    // Recent Transactions
    recentTransactions: recentTransactions.map((t: any) => ({
      id: t.id,
      transactionId: t.transactionId,
      customer: t.user?.name || 'Unknown',
      customerPhoto: t.user?.profileImage || '',
      bookingId: t.booking?.id || '',
      amount: t.amount,
      method: t.method,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  };
};

export const MetaService = {
  fetchDashboardMetaData,
};
