import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Payment } from '../payment/payment.model';
import { User } from '../user/user.model';
import { Booking } from '../booking/booking.model';
import { PAYMENT_STATUS } from '../payment/payment.constant';
import { USER_ROLE, USER_STATUS } from '../user/user.constant';

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
        totalRefunded: { $sum: '$refundAmount' },
      },
    },
  ];

  const [financialData] = await Payment.aggregate(paymentPipeline);

  // ── Determine amount sorting direction: 'asc' vs 'desc' / 'dsc' ──
  let sortOption: Record<string, 1 | -1> = { createdAt: -1 };

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
    sortOption = { amount: 1, createdAt: -1 };
  } else if (isDesc) {
    sortOption = { amount: -1, createdAt: -1 };
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
    .select('id method transactionId amount status createdAt')
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
        totalRefunded: { $sum: '$refundAmount' },
      },
    },
  ]);

  const salesData = salesReport[0] || {
    totalIncome: 0,
    totalPlatformCommission: 0,
    totalRefunded: 0,
  };

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

    // Sales Report
    salesReport: {
      totalIncome: salesData.totalIncome,
      platformCommission: salesData.totalPlatformCommission,
      refunded: salesData.totalRefunded,
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
    })),
  };
};

export const MetaService = {
  fetchDashboardMetaData,
};
