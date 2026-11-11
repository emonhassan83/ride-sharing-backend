import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { RIDE_STATUS, RIDE_TYPE } from './ride.constant';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS, PAYMENT_STATUS } from '../passenger/passenger.constant';
import { Booking } from '../booking/booking.model';
import { Payment } from '../payment/payment.model';
import { Provider } from '../provider/provider.model';
import { User } from '../user/user.model';
import { SettingService } from '../settings/settings.service';
import { USER_ROLE } from '../user/user.constant';
import { buildStoredFareBreakdown } from '../../utils/fareBreakdownResponse.utils';
import { toLuggageFyiView } from '../../utils/luggage.utils';
import { loadFareSettings } from '../../utils/fareCalculator';
import {
  computeDriverPayoutFromPassengerTotal,
  roundMoney as roundMoneyPrecise,
} from '../../utils/fareMath.utils';
import {
  sendRideStartOtp,
  verifyRideStartOtp,
} from '../../utils/rideStartOtp.utils';

const pad2 = (n: number) => String(n).padStart(2, '0');

const toDateLabel = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const getDriverMonthlyInvoice = async (
  requester: { userId: string; role: string },
  query: { year: number; month: number; driverId?: string },
) => {
  const year = Number(query.year);
  const month = Number(query.month);

  let driverId = requester.userId;
  if (requester.role === USER_ROLE.admin) {
    if (!query.driverId) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        'driverId is required for admin',
      );
    }
    driverId = query.driverId;
  } else if (query.driverId && query.driverId !== requester.userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'You can only view your own invoice',
    );
  }

  const user = await User.findById(driverId)
    .select('name address type role')
    .lean();
  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Driver not found');
  }

  const provider = await Provider.findOne({ userId: driverId })
    .select('companyName companyReg vatNumber ibanNumber')
    .lean();

  const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const nextMonthStart = new Date(year, month, 1, 0, 0, 0, 0);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
  const startDate = toDateLabel(monthStart);
  const endDate = toDateLabel(monthEnd);

  const rides = await Ride.find({
    driverId,
    status: RIDE_STATUS.completed,
    driverEarningCredited: true,
    completedAt: { $gte: monthStart, $lt: nextMonthStart },
  })
    .select(
      'type totalCollectedAmount driverEarningAmount platformCommissionAmount currentSurchargePercent completedAt',
    )
    .lean();

  const fareSettings = await loadFareSettings();
  const payoutSettings = {
    driverPlatformFeePercent: fareSettings.driverPlatformFeePercent,
    driverVatPercent: fareSettings.driverVatPercent,
    platformCommissionPercent: fareSettings.platformCommissionPercent,
    splitRideMatchedSurchargePercent:
      fareSettings.splitRideMatchedSurchargePercent,
  };

  let netEarning = 0;
  let vatAmount = 0;

  for (const ride of rides) {
    const collected = Number((ride as any).totalCollectedAmount || 0);
    const storedNet = Number((ride as any).driverEarningAmount || 0);
    netEarning += storedNet;

    if (collected > 0) {
      const isMatchedSplit =
        (ride as any).type === 'split' &&
        Number((ride as any).currentSurchargePercent || 0) > 0;
      const payout = computeDriverPayoutFromPassengerTotal(
        collected,
        (ride as any).type === 'split' ? 'split' : 'private',
        payoutSettings,
        isMatchedSplit,
      );
      vatAmount += payout.driverVatAmount;
    } else if (storedNet > 0) {
      // Fallback: reverse VAT from net using current vat %
      // net = afterFee * (1 - v/(100+v))? Actually net = afterFee - vat, vat = afterFee * v/100
      // afterFee = net / (1 - v/100)
      const v = payoutSettings.driverVatPercent;
      if (v > 0 && v < 100) {
        const afterFee = roundMoneyPrecise(storedNet / (1 - v / 100));
        vatAmount += roundMoneyPrecise(afterFee - storedNet);
      }
    }
  }

  netEarning = roundMoneyPrecise(netEarning);
  vatAmount = roundMoneyPrecise(vatAmount);
  const totalEarning = roundMoneyPrecise(netEarning + vatAmount);
  const seller = await SettingService.getPlatformSeller();
  const invoiceId = `CY${year}${pad2(month)}-${String(driverId).slice(-6).toUpperCase()}`;

  return {
    invoiceId,
    period: {
      year,
      month,
      startDate,
      endDate,
      label: `${startDate} - ${endDate}`,
    },
    driver: {
      name: user.name || '',
      address: (user as any).address || '',
      type: (user as any).type || null,
      companyName: provider?.companyName || null,
      companyReg: provider?.companyReg || null,
      vatNumber: provider?.vatNumber || null,
      ibanNumber: provider?.ibanNumber || null,
    },
    seller,
    summary: {
      rideCount: rides.length,
      netEarning,
      vatPercent: payoutSettings.driverVatPercent,
      vatAmount,
      totalEarning,
    },
  };
};

const getAllIntoDB = async (query: Record<string, unknown>) => {
  // ──────────────────────────────────────────────────────────
  const status = query.status as string | undefined;
  delete query.status;

  let statusFilter: any;

  if (status === 'scheduled') {
    statusFilter = {
      status: { $in: [RIDE_STATUS.accepted, RIDE_STATUS.started] },
    };
  } else if (status === 'completed') {
    statusFilter = {
      status: RIDE_STATUS.completed,
    };
  } else {
    // default - exclude pending, cancelled, rejected
    statusFilter = {
      status: {
        $nin: [
          RIDE_STATUS.pending,
          RIDE_STATUS.cancelled,
          RIDE_STATUS.rejected,
        ],
      },
    };
  }

  const rideQuery = new QueryBuilder(
    Ride.find(statusFilter)
      .populate([
        { path: 'driverId', select: 'name' },
        { path: 'rideCreatedBy', select: 'name' },
      ])
      .select(
        'id pickup destination departureDate departureTime bookedSeats status createdAt type driverId rideCreatedBy'
      ),
    query
  )
    .filter()
    .sort()
    .paginate()
    .fields();

  const [result, meta] = await Promise.all([
    rideQuery.modelQuery,
    rideQuery.countTotal(),
  ]);

  return { meta, result };
};

const PAID_PAYMENT_STATUSES = [
  PAYMENT_STATUS.authorized,
  PAYMENT_STATUS.paid,
] as const;

const isPaidPaymentStatus = (status: unknown) =>
  PAID_PAYMENT_STATUSES.includes(status as (typeof PAID_PAYMENT_STATUSES)[number]);

const normalizeRideTypeValue = (rawType: unknown): string | null => {
  if (!rawType || typeof rawType !== 'string') return null;
  const normalized = rawType.trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === RIDE_TYPE.split || normalized === 'shared') {
    return RIDE_TYPE.split;
  }
  if (normalized === RIDE_TYPE.private || normalized === 'solo') {
    return RIDE_TYPE.private;
  }
  return normalized;
};

const buildDateFilterVariants = (rawDate: unknown): string[] | null => {
  if (!rawDate || typeof rawDate !== 'string') return null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;

  const variants = new Set<string>([trimmed]);
  // Match YYYY-MM-DD or YYYY/MM/DD
  const ymdMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const [, yyyy, m, d] = ymdMatch;
    const mm = m.padStart(2, '0');
    const dd = d.padStart(2, '0');
    variants.add(`${yyyy}-${mm}-${dd}`);
    variants.add(`${dd}-${mm}-${yyyy}`);
    variants.add(`${yyyy}/${mm}/${dd}`);
    variants.add(`${dd}/${mm}/${yyyy}`);
  }

  // Match DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, yyyy] = dmyMatch;
    const dd = d.padStart(2, '0');
    const mm = m.padStart(2, '0');
    variants.add(`${dd}-${mm}-${yyyy}`);
    variants.add(`${yyyy}-${mm}-${dd}`);
    variants.add(`${dd}/${mm}/${yyyy}`);
    variants.add(`${yyyy}/${mm}/${dd}`);
  }

  return Array.from(variants);
};

const buildTimeFilterVariants = (rawTime: unknown): string[] | null => {
  if (!rawTime || typeof rawTime !== 'string') return null;
  const trimmed = rawTime.trim();
  if (!trimmed) return null;

  const variants = new Set<string>([trimmed, trimmed.toUpperCase(), trimmed.toLowerCase()]);

  // 12-hour format: e.g. "02:00 PM" or "2:00 pm"
  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const minute = ampmMatch[2];
    const period = ampmMatch[3].toUpperCase();
    const hour12NoPad = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const hour12Pad = String(hour12NoPad).padStart(2, '0');

    if (period === 'PM' && hour < 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    const hour24Pad = String(hour).padStart(2, '0');

    variants.add(`${hour24Pad}:${minute}`);
    variants.add(`${hour}:${minute}`);
    variants.add(`${hour12Pad}:${minute} ${period}`);
    variants.add(`${hour12NoPad}:${minute} ${period}`);
    variants.add(`${hour12Pad}:${minute} ${period.toLowerCase()}`);
    variants.add(`${hour12NoPad}:${minute} ${period.toLowerCase()}`);
  }

  // 24-hour format: e.g. "14:00" or "09:30"
  const h24Match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (h24Match) {
    const hour24 = parseInt(h24Match[1], 10);
    const minute = h24Match[2];
    if (hour24 >= 0 && hour24 <= 23) {
      const hour24Pad = String(hour24).padStart(2, '0');
      const period = hour24 >= 12 ? 'PM' : 'AM';
      const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
      const hour12Pad = String(hour12).padStart(2, '0');

      variants.add(`${hour24Pad}:${minute}`);
      variants.add(`${hour24}:${minute}`);
      variants.add(`${hour12Pad}:${minute} ${period}`);
      variants.add(`${hour12}:${minute} ${period}`);
      variants.add(`${hour12Pad}:${minute} ${period.toLowerCase()}`);
      variants.add(`${hour12}:${minute} ${period.toLowerCase()}`);
    }
  }

  return Array.from(variants);
};

const resolveRideStatusesFromQuery = (rawStatus: unknown): {
  isPendingList: boolean;
  includesCancelledOrRejected: boolean;
  statuses: string[] | null;
} => {
  if (!rawStatus || typeof rawStatus !== 'string') {
    return {
      isPendingList: false,
      includesCancelledOrRejected: false,
      statuses: null,
    };
  }

  const tokens = rawStatus
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length || tokens.includes('all')) {
    return {
      isPendingList: false,
      includesCancelledOrRejected: true,
      statuses: [
        RIDE_STATUS.accepted,
        RIDE_STATUS.arrived,
        RIDE_STATUS.started,
        RIDE_STATUS.completed,
        RIDE_STATUS.cancelled,
        RIDE_STATUS.rejected,
      ],
    };
  }

  const resolved = new Set<string>();
  for (const token of tokens) {
    if (token === RIDE_STATUS.pending || token === 'request' || token === 'requests') {
      resolved.add(RIDE_STATUS.pending);
    } else if (token === 'upcoming' || token === 'scheduled') {
      resolved.add(RIDE_STATUS.accepted);
    } else if (
      token === 'ongoing' ||
      token === 'active' ||
      token === 'in_progress' ||
      token === 'in-progress' ||
      token === 'running'
    ) {
      resolved.add(RIDE_STATUS.arrived);
      resolved.add(RIDE_STATUS.started);
    } else if (token === 'history' || token === 'past') {
      resolved.add(RIDE_STATUS.completed);
      resolved.add(RIDE_STATUS.cancelled);
      resolved.add(RIDE_STATUS.rejected);
    } else if (token === 'cancelled' || token === 'canceled') {
      resolved.add(RIDE_STATUS.cancelled);
    } else if (token === RIDE_STATUS.rejected) {
      resolved.add(RIDE_STATUS.rejected);
    } else if (token === RIDE_STATUS.completed) {
      resolved.add(RIDE_STATUS.completed);
    } else if (token === RIDE_STATUS.accepted) {
      resolved.add(RIDE_STATUS.accepted);
    } else if (token === RIDE_STATUS.arrived) {
      resolved.add(RIDE_STATUS.arrived);
    } else if (token === RIDE_STATUS.started) {
      resolved.add(RIDE_STATUS.started);
    }
  }

  const statusList = Array.from(resolved);
  const isPendingList =
    statusList.length === 1 && statusList[0] === RIDE_STATUS.pending;
  const includesCancelledOrRejected =
    statusList.includes(RIDE_STATUS.cancelled) ||
    statusList.includes(RIDE_STATUS.rejected);

  return {
    isPendingList,
    includesCancelledOrRejected,
    statuses: statusList.length ? statusList : null,
  };
};

const getDriverRides = async (
  userId: string,
  query: Record<string, unknown>
) => {
  const { isPendingList, includesCancelledOrRejected, statuses } =
    resolveRideStatusesFromQuery(query.status);

  const normalizedType = normalizeRideTypeValue(query.type ?? query.rideType);
  const dateVariants = buildDateFilterVariants(query.departureDate ?? query.date);
  const timeVariants = buildTimeFilterVariants(query.departureTime ?? query.time);

  const baseRideCondition: Record<string, unknown> = isPendingList
    ? {
        $or: [
          {
            status: RIDE_STATUS.pending,
            $or: [{ driverId: userId }, { notifiedDriverIds: userId }],
          },
          {
            type: RIDE_TYPE.split,
            status: RIDE_STATUS.accepted,
            $or: [{ driverId: userId }, { notifiedDriverIds: userId }],
          },
        ],
      }
    : {
        driverId: userId,
        status: statuses
          ? statuses.length === 1
            ? statuses[0]
            : { $in: statuses }
          : {
              $nin: [
                RIDE_STATUS.pending,
                RIDE_STATUS.cancelled,
                RIDE_STATUS.rejected,
              ],
            },
      };

  if (normalizedType) {
    baseRideCondition.type = normalizedType;
  }
  if (dateVariants) {
    baseRideCondition.departureDate = { $in: dateVariants };
  }
  if (timeVariants) {
    baseRideCondition.departureTime = { $in: timeVariants };
  }

  const driverRides = await Ride.find(baseRideCondition)
    .select('_id status')
    .lean();
  const driverRideIds = driverRides.map(r => r._id);
  const cancelledOrRejectedRideIdSet = new Set(
    driverRides
      .filter(
        r =>
          r.status === RIDE_STATUS.cancelled ||
          r.status === RIDE_STATUS.rejected,
      )
      .map(r => r._id.toString()),
  );

  const passengers = await Passenger.find({
    rideId: { $in: driverRideIds },
    status: isPendingList
      ? {
          $nin: [
            PASSENGER_STATUS.cancelled,
            PASSENGER_STATUS.rejected,
            PASSENGER_STATUS.split_matching,
          ],
        }
      : includesCancelledOrRejected
        ? {
            $nin: [PASSENGER_STATUS.split_matching],
          }
        : {
            $nin: [
              PASSENGER_STATUS.pending,
              PASSENGER_STATUS.cancelled,
              PASSENGER_STATUS.rejected,
              PASSENGER_STATUS.split_matching,
            ],
          },
  }).select('_id rideId status paymentStatus');

  const passengerIds = passengers.map(p => p._id);
  const bookings = await Booking.find({
    passengerId: { $in: passengerIds },
  })
    .select('passengerId paymentStatus')
    .lean();
  const bookingPaymentByPassengerId = new Map(
    bookings.map(b => [b.passengerId.toString(), b.paymentStatus]),
  );

  const eligiblePassengerIds = new Set<string>();
  const eligibleRideIdSet = new Set<string>();

  // Keep cancelled/rejected driver rides visible even if bookings were refunded/cancelled
  if (includesCancelledOrRejected) {
    for (const cancelledRideId of cancelledOrRejectedRideIdSet) {
      eligibleRideIdSet.add(cancelledRideId);
    }
  }

  const pendingPassengerRideIdSet = new Set<string>();
  if (isPendingList) {
    for (const p of passengers) {
      if (p.status === PASSENGER_STATUS.pending) {
        pendingPassengerRideIdSet.add(p.rideId?.toString() || '');
      }
    }
  }

  for (const p of passengers) {
    if (!p.rideId) continue;
    const rideIdStr = p.rideId.toString();
    const isCancelledOrRejectedRide = cancelledOrRejectedRideIdSet.has(rideIdStr);
    const paymentStatus =
      bookingPaymentByPassengerId.get(p._id.toString()) ?? p.paymentStatus;

    if (!isCancelledOrRejectedRide && !isPaidPaymentStatus(paymentStatus)) {
      continue;
    }

    if (isPendingList) {
      // In pending list, only include rides that have pending passengers and only show pending passengers
      if (!pendingPassengerRideIdSet.has(rideIdStr)) continue;
      if (p.status !== PASSENGER_STATUS.pending) continue;
    }

    eligiblePassengerIds.add(p._id.toString());
    eligibleRideIdSet.add(rideIdStr);
  }

  const eligibleRideIds = Array.from(eligibleRideIdSet);

  // If no rides are eligible, return empty result with pagination metadata
  if (!eligibleRideIds.length) {
    return {
      meta: {
        page: Number(query.page) || 1,
        limit: Number(query.limit) || 10,
        total: 0,
        totalPage: 0,
      },
      result: [],
    };
  }

  const sanitizedQuery: Record<string, unknown> = { ...query };
  delete sanitizedQuery.status;
  delete sanitizedQuery.type;
  delete sanitizedQuery.rideType;
  delete sanitizedQuery.date;
  delete sanitizedQuery.departureDate;
  delete sanitizedQuery.time;
  delete sanitizedQuery.departureTime;

  const sortRaw = String(sanitizedQuery.sort || 'desc').toLowerCase();
  const sortAsc =
    sortRaw === 'asc' ||
    sortRaw === 'createdat' ||
    sortRaw === 'createdat:asc' ||
    sortRaw === 'created_at' ||
    sortRaw === 'created_at:asc';
  sanitizedQuery.sort = sortAsc ? 'createdAt' : '-createdAt';

  const rideQuery = new QueryBuilder(
    Ride.find({
      _id: { $in: eligibleRideIds },
    })
      .populate([
        { path: 'driverId', select: 'name' },
        { path: 'rideCreatedBy', select: 'name' },
      ])
      .select(
        'id pickup destination departureDate departureTime bookedSeats status createdAt type driverId rideCreatedBy'
      ),
    sanitizedQuery
  )
    .filter()
    .sort()
    .paginate()
    .fields();

  const [result, meta] = await Promise.all([
    rideQuery.modelQuery,
    rideQuery.countTotal(),
  ]);

  if (!result.length) return { meta, result };

  const rideIds = result.map(r => r._id);
  const allPassengers = await Passenger.find({
    _id: { $in: Array.from(eligiblePassengerIds) },
    rideId: { $in: rideIds },
  })
    .populate('userId', 'name')
    .lean();

  const passengerMap = new Map<string, string[]>();
  for (const p of allPassengers) {
    const rideId = typeof p.rideId === 'object' && p.rideId
      ? (p.rideId as any)._id || p.rideId
      : p.rideId;
    const rideIdStr = rideId.toString();
    if (!passengerMap.has(rideIdStr)) {
      passengerMap.set(rideIdStr, []);
    }
    const userName = (p as any).userId?.name || '';
    if (userName) {
      passengerMap.get(rideIdStr)!.push(userName);
    }
  }

  const resultWithPassengers = result.map(ride => ({
    ...ride.toObject ? ride.toObject() : ride,
    passengers: passengerMap.get(ride._id.toString()) || [],
  }));

  return { meta, result: resultWithPassengers };
};

const getRiderRides = async (
  userId: string,
  query: Record<string, unknown>,
) => {
  const { isPendingList, includesCancelledOrRejected, statuses } =
    resolveRideStatusesFromQuery(query.status);

  const normalizedType = normalizeRideTypeValue(query.type ?? query.rideType);
  const dateVariants = buildDateFilterVariants(query.departureDate ?? query.date);
  const timeVariants = buildTimeFilterVariants(query.departureTime ?? query.time);

  const rideStatusFilter: Record<string, unknown> = {};
  if (statuses && !isPendingList) {
    rideStatusFilter.status =
      statuses.length === 1 ? statuses[0] : { $in: statuses };
  }
  if (normalizedType) {
    rideStatusFilter.type = normalizedType;
  }

  const passengerFindFilter: Record<string, unknown> = {
    userId,
    status: isPendingList
      ? {
          $in: [
            PASSENGER_STATUS.pending,
            PASSENGER_STATUS.split_matching,
          ],
        }
      : includesCancelledOrRejected
        ? {
            $nin: [
              PASSENGER_STATUS.pending,
              PASSENGER_STATUS.split_matching,
            ],
          }
        : {
            $nin: [
              PASSENGER_STATUS.pending,
              PASSENGER_STATUS.cancelled,
              PASSENGER_STATUS.rejected,
              PASSENGER_STATUS.split_matching,
            ],
          },
  };

  if (dateVariants) {
    passengerFindFilter.departureDate = { $in: dateVariants };
  }
  if (timeVariants) {
    passengerFindFilter.departureTime = { $in: timeVariants };
  }

  const passengerDocs = await Passenger.find(passengerFindFilter)
    .select(
      'rideId pickup destination requestedSeats status estimatedFare paymentStatus departureDate departureTime largeSuitcase smallSuitcase luggageNote luggageCounts note createdAt',
    )
    .lean();

  if (!passengerDocs.length) {
    return { meta: { page: 1, limit: 10, total: 0, totalPage: 0 }, result: [] };
  }

  const passengerIds = passengerDocs.map(p => p._id);

  const bookings = await Booking.find({
    passengerId: { $in: passengerIds },
  })
    .select('id passengerId paymentStatus bookingStatus')
    .lean();

  const bookingMap = new Map(
    bookings.map(b => [b.passengerId.toString(), b]),
  );

  const paidStatuses = new Set<string>([
    PAYMENT_STATUS.authorized,
    PAYMENT_STATUS.paid,
  ]);

  const eligiblePassengers = isPendingList
    ? passengerDocs.filter(p => {
        const booking = bookingMap.get(p._id.toString());
        const paymentStatus = booking?.paymentStatus || p.paymentStatus;
        return paidStatuses.has(String(paymentStatus));
      })
    : passengerDocs;

  if (!eligiblePassengers.length) {
    return { meta: { page: 1, limit: 10, total: 0, totalPage: 0 }, result: [] };
  }

  const rideIds = eligiblePassengers
    .map(p => p.rideId)
    .filter(Boolean) as any[];

  const rides = await Ride.find({
    _id: { $in: rideIds },
    ...(isPendingList
      ? {
          status: RIDE_STATUS.pending,
          ...(normalizedType ? { type: normalizedType } : {}),
        }
      : rideStatusFilter),
  })
    .populate([{ path: 'driverId', select: 'name profileImage phone email' }])
    .select(
      'id type status driverId departureDate departureTime totalSeats bookedSeats malePassengers femalePassengers createdAt',
    )
    .lean();

  const rideMap = new Map(rides.map(r => [r._id.toString(), r]));

  const result = eligiblePassengers
    .map(p => {
      const ride = p.rideId ? rideMap.get(p.rideId.toString()) : undefined;
      const booking = bookingMap.get(p._id.toString());
      const isUnmatchedSplit = p.status === PASSENGER_STATUS.split_matching;
      const isPassengerCancelledOrRejected =
        p.status === PASSENGER_STATUS.cancelled ||
        p.status === PASSENGER_STATUS.rejected;

      if (isPendingList) {
        if (!isUnmatchedSplit && !ride) return null;
        if (normalizedType && isUnmatchedSplit && normalizedType !== RIDE_TYPE.split) {
          return null;
        }
      } else if (!ride) {
        if (!(includesCancelledOrRejected && isPassengerCancelledOrRejected)) {
          return null;
        }
      }

      return {
        userId,
        passengerId: p._id,
        requestedSeats: p.requestedSeats,
        estimatedFare: p.estimatedFare,
        pickup: p.pickup,
        destination: p.destination,
        departureDate: p.departureDate,
        departureTime: p.departureTime,
        createdAt: (p as any).createdAt || null,
        ...toLuggageFyiView(p),

        bookingId: booking?._id || null,
        bookingShortId: booking?.id || null,
        paymentStatus: booking?.paymentStatus || p.paymentStatus || null,

        rideId: ride?._id ?? null,
        rideType: ride?.type ?? (isUnmatchedSplit ? RIDE_TYPE.split : null),
        rideStatus:
          ride?.status ??
          (isPassengerCancelledOrRejected ? p.status : RIDE_STATUS.pending),
        passengerStatus: p.status,

        driver: ride?.driverId || null,
      };
    })
    .filter(Boolean);

  const sortRaw = String(query.sort || 'desc').toLowerCase();
  const sortAsc =
    sortRaw === 'asc' ||
    sortRaw === 'createdat' ||
    sortRaw === 'createdat:asc' ||
    sortRaw === 'created_at' ||
    sortRaw === 'created_at:asc';

  result.sort((a: any, b: any) => {
    const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    return sortAsc ? aTime - bTime : bTime - aTime;
  });

  const page = parseInt(String(query.page || 1));
  const limit = parseInt(String(query.limit || 10));
  const skip = (page - 1) * limit;
  const total = result.length;

  const paginated = result.slice(skip, skip + limit);

  return {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    result: paginated,
  };
};

const roundMoney = (value: any): number => Math.round(Number(value || 0) * 100) / 100;

const getRideById = async (rideId: string) => {
  const ride = await Ride.findById(rideId)
    .populate([
      { path: 'driverId', select: 'name email phone profileImage type address' },
      { path: 'vehicleId', select: 'name number year seats' },
      { path: 'rideCreatedBy', select: 'name email phone profileImage' },
    ])
    .select(
      'id pickup destination departureDate departureTime totalSeats bookedSeats malePassengers femalePassengers status createdAt completedAt type driverId vehicleId rideCreatedBy driverEarningCredited driverEarningCreditedAt driverEarningAmount platformCommissionAmount totalCollectedAmount currentSurchargePercent splitFareLocked splitFareLockedAt splitFareLockReason'
    )
    .lean();

  if (!ride) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  const passengers = await Passenger.find({ rideId })
    .populate('userId', 'name email phone profileImage')
    .lean();

  const passengerIds = passengers.map((passenger: any) => passenger._id);
  const bookings = await Booking.find({
    $or: [{ rideId }, { passengerId: { $in: passengerIds } }],
  })
    .select('_id id passengerId userId driverId paymentStatus bookingStatus totalFare amountPaid transactionId refundAmount createdAt updatedAt')
    .lean();

  const bookingIds = bookings.map((booking: any) => booking._id);
  const payments = await Payment.find({ booking: { $in: bookingIds }, isDeleted: false })
    .select('_id id user provider booking method transactionId platformCommission providerEarning amount authorizedAmount amountToCapture status paymentIntentId isPaid createdAt updatedAt')
    .lean();

  const bookingByPassengerId = new Map(
    bookings.map((booking: any) => [booking.passengerId?.toString(), booking])
  );
  const paymentByBookingId = new Map(
    payments.map((payment: any) => [payment.booking?.toString(), payment])
  );

  const driverId = (ride as any).driverId?._id || (ride as any).driverId || null;
  const providerProfile = driverId
    ? await Provider.findOne({ userId: driverId })
        .select('companyName companyReg vatNumber status')
        .lean()
    : null;

  const passengersWithFareBreakdown = await Promise.all(
    passengers.map(async (passenger: any) => {
      const booking = bookingByPassengerId.get(passenger._id.toString());
      const payment = booking ? paymentByBookingId.get(booking._id.toString()) : null;
      return {
        ...passenger,
        ...toLuggageFyiView(passenger),
        bookingId: booking?._id || null,
        bookingShortId: booking?.id || null,
        paymentStatus: booking?.paymentStatus || passenger.paymentStatus,
        bookingStatus: booking?.bookingStatus || null,
        fareBreakdown: await buildStoredFareBreakdown(passenger, booking, ride),
        booking: booking
          ? {
              id: booking._id,
              shortId: booking.id,
              status: booking.bookingStatus,
              paymentStatus: booking.paymentStatus,
              totalFare: booking.totalFare,
              amountPaid: booking.amountPaid,
              transactionId: booking.transactionId || null,
              refundAmount: booking.refundAmount || 0,
            }
          : null,
        payment: payment
          ? {
              id: payment._id,
              shortId: payment.id,
              method: payment.method,
              transactionId: payment.transactionId,
              status: payment.status,
              isPaid: payment.isPaid,
              amount: payment.amount,
              authorizedAmount: payment.authorizedAmount,
              amountToCapture: payment.amountToCapture,
              platformCommission: payment.platformCommission,
              providerEarning: payment.providerEarning,
              paymentIntentId: payment.paymentIntentId,
            }
          : null,
      };
    })
  );

  const totalPassengerPaid = roundMoney(
    payments.reduce((sum: number, payment: any) => sum + Number(payment.amount || 0), 0)
  );
  const totalAuthorizedAmount = roundMoney(
    payments.reduce((sum: number, payment: any) => sum + Number(payment.authorizedAmount || 0), 0)
  );
  const totalAmountToCapture = roundMoney(
    payments.reduce((sum: number, payment: any) => sum + Number(payment.amountToCapture || 0), 0)
  );
  const paymentPlatformCommission = roundMoney(
    payments.reduce((sum: number, payment: any) => sum + Number(payment.platformCommission || 0), 0)
  );
  const paymentProviderEarning = roundMoney(
    payments.reduce((sum: number, payment: any) => sum + Number(payment.providerEarning || 0), 0)
  );
  const rideTotalCollectedAmount = roundMoney((ride as any).totalCollectedAmount || 0);
  const ridePlatformFeeAmount = roundMoney((ride as any).platformCommissionAmount || 0);
  const rideDriverEarningAmount = roundMoney((ride as any).driverEarningAmount || 0);

  const platformReceived = roundMoney(
    rideTotalCollectedAmount || totalAmountToCapture || totalPassengerPaid,
  );
  const platformFeeAmount = roundMoney(
    ridePlatformFeeAmount || paymentPlatformCommission || 0,
  );
  const driverEarning = roundMoney(
    rideDriverEarningAmount ||
      paymentProviderEarning ||
      Math.max(platformReceived - platformFeeAmount, 0),
  );
  const vatAmount = roundMoney(
    Math.max(platformReceived - driverEarning - platformFeeAmount, 0),
  );
  const seller = await SettingService.getPlatformSeller();

  const invoiceOverview = {
    rideId: (ride as any)._id,
    rideReference: (ride as any).id || null,
    rideType: (ride as any).type,
    rideStatus: (ride as any).status,
    rideDate: (ride as any).departureDate,
    rideTime: (ride as any).departureTime,
    pickup: (ride as any).pickup,
    destination: (ride as any).destination,
    driver: (ride as any).driverId
      ? {
          ...(ride as any).driverId,
          invoiceProfile: providerProfile
            ? {
                companyName: providerProfile.companyName || null,
                companyReg: providerProfile.companyReg || null,
                vatNumber: providerProfile.vatNumber || null,
                kycStatus: providerProfile.status || null,
              }
            : null,
        }
      : null,
    seller,
    totals: {
      platformReceived,
      driverEarning,
      platformFeeAmount,
      vatAmount,
    },
    payments: payments.map((payment: any) => {
      const booking = bookings.find((item: any) => item._id.toString() === payment.booking?.toString());
      return {
        paymentId: payment._id,
        paymentShortId: payment.id,
        bookingId: booking?._id || payment.booking,
        bookingReference: booking?.id || null,
        passengerId: booking?.passengerId || null,
        method: payment.method,
        transactionId: payment.transactionId,
        status: payment.status,
        isPaid: payment.isPaid,
        amount: payment.amount,
        authorizedAmount: payment.authorizedAmount,
        amountToCapture: payment.amountToCapture,
        platformCommission: payment.platformCommission,
        providerEarning: payment.providerEarning,
      };
    }),
  };

  return {
    ...ride,
    passengers: passengersWithFareBreakdown,
    invoiceOverview,
  };
};

const ACTIVE_RIDE_STATUSES_FOR_DELETE = [
  RIDE_STATUS.pending,
  RIDE_STATUS.accepted,
  RIDE_STATUS.started,
] as const;

const deleteARide = async (rideId: string) => {
  const ride = await Ride.findById(rideId).select('_id status');
  if (!ride) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  if (
    ACTIVE_RIDE_STATUSES_FOR_DELETE.includes(
      ride.status as (typeof ACTIVE_RIDE_STATUSES_FOR_DELETE)[number],
    )
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Cannot delete an active ride',
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const deletedAt = new Date();
    const deletedRide = await Ride.findByIdAndUpdate(
      rideId,
      { isDeleted: true, deletedAt },
      { returnDocument: 'after', session },
    );
    if (!deletedRide) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
    }

    await Passenger.updateMany(
      { rideId, isDeleted: { $ne: true } },
      { isDeleted: true, deletedAt },
      { session },
    );

    await session.commitTransaction();
    return deletedRide;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const RideService = {
  getAllIntoDB,
  getDriverRides,
  getRiderRides,
  getRideById,
  getDriverMonthlyInvoice,
  deleteARide,
  sendRideStartOtp,
  verifyRideStartOtp,
};




