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
  const { revenue_year } = query;

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

  // Recent Transactions (Latest 5)
  const recentTransactions = await Payment.find({
    isDeleted: false,
  })
    .populate('user', 'name profileImage')
    .populate('provider', 'name')
    .populate('booking', 'id')
    .sort({ createdAt: -1 })
    .limit(5)
    .select('id method transactionId amount status createdAt')
    .lean();

  // Sales Report Summary (Current Year)
  const salesReport = await Payment.aggregate([
    {
      $match: {
        isDeleted: false,
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
      customerPhoto: t.user.profileImage || "",
      bookingId: t.booking.id,
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
