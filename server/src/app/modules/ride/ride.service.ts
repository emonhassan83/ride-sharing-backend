import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { RIDE_STATUS } from './ride.constant';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS, PAYMENT_STATUS } from '../passenger/passenger.constant';
import { Booking } from '../booking/booking.model';
import { Payment } from '../payment/payment.model';
import { Provider } from '../provider/provider.model';
import { Setting } from '../settings/settings.model';
import { buildStoredFareBreakdown } from '../../utils/fareBreakdownResponse.utils';

const getAllIntoDB = async (query: Record<string, unknown>) => {
  // Ã¢â€â‚¬Ã¢â€â‚¬ Filter type: scheduled | completed | all (default) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    // default Ã¢â‚¬â€ exclude pending, cancelled, rejected
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

const getDriverRides = async (
  userId: string,
  query: Record<string, unknown>
) => {
  // 1. Fetch all rides for the driver that are not pending/cancelled/rejected
  const driverRides = await Ride.find({
    driverId: userId,
    status: {
      $nin: [
        RIDE_STATUS.pending,
        RIDE_STATUS.cancelled,
        RIDE_STATUS.rejected,
      ],
    },
  }).select('_id');

  const driverRideIds = driverRides.map(r => r._id);

  // 2. Fetch all passengers of these rides who are not pending/cancelled/rejected
  const passengers = await Passenger.find({
    rideId: { $in: driverRideIds },
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
        PASSENGER_STATUS.split_matching,
      ],
    },
  }).select('rideId paymentStatus');

  // 3. Count passengers per ride and check payment status
  const ridePassengerMap = new Map<string, { count: number; hasPaid: boolean }>();
  for (const p of passengers) {
    if (!p.rideId) continue;
    const rideIdStr = p.rideId.toString();
    if (!ridePassengerMap.has(rideIdStr)) {
      ridePassengerMap.set(rideIdStr, { count: 0, hasPaid: false });
    }
    const info = ridePassengerMap.get(rideIdStr)!;
    info.count += 1;
    if ([PAYMENT_STATUS.authorized, PAYMENT_STATUS.paid].includes(p.paymentStatus as any)) {
      info.hasPaid = true;
    }
  }

  // 4. Identify eligible rides:
  // - Show if passenger count > 1
  // - Show if passenger count === 1 and that passenger has authorized/paid payment
  const eligibleRideIds: string[] = [];
  for (const [rideIdStr, info] of ridePassengerMap.entries()) {
    if (info.count > 1 || (info.count === 1 && info.hasPaid)) {
      eligibleRideIds.push(rideIdStr);
    }
  }

  // 5. If no rides are eligible, return empty result with pagination metadata
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

  if (!result.length) return { meta, result };

  const rideIds = result.map(r => r._id);
  const allPassengers = await Passenger.find({
    rideId: { $in: rideIds },
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
        PASSENGER_STATUS.split_matching,
      ],
    },
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
  // Ã¢â€â‚¬Ã¢â€â‚¬ Step 1: Ride status filter Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const rideStatusFilter: Record<string, any> = {};
  if (query.status) {
    rideStatusFilter.status = query.status;
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Step 2: Find passengers (non-cancelled/rejected/pending) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const passengerDocs = await Passenger.find({
    userId,
    status: {
      $nin: [
        PASSENGER_STATUS.pending,
        PASSENGER_STATUS.cancelled,
        PASSENGER_STATUS.rejected,
        PASSENGER_STATUS.split_matching,
      ],
    },
  })
    .select('rideId pickup destination requestedSeats status estimatedFare departureDate departureTime')
    .lean();

  if (!passengerDocs.length)
    return { meta: { page: 1, limit: 10, total: 0, totalPage: 0 }, result: [] };

  const passengerIds = passengerDocs.map(p => p._id);
  const rideIds = passengerDocs.map(p => p.rideId).filter(Boolean) as any[];

  // Ã¢â€â‚¬Ã¢â€â‚¬ Step 3: Find rides with status filter Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const rides = await Ride.find({
    _id: { $in: rideIds },
    ...rideStatusFilter,
  })
    .populate([{ path: 'driverId', select: 'name profileImage phone email' }])
    .select('id type status driverId departureDate departureTime totalSeats bookedSeats malePassengers femalePassengers createdAt')
    .lean();

  const rideMap = new Map(rides.map(r => [r._id.toString(), r]));

  // Ã¢â€â‚¬Ã¢â€â‚¬ Step 4: Find bookings for these passengers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const bookings = await Booking.find({
    passengerId: { $in: passengerIds },
  })
    .select('id passengerId paymentStatus bookingStatus')
    .lean();

  // Booking lookup map by passengerId
  const bookingMap = new Map(
    bookings.map(b => [b.passengerId.toString(), b]),
  );

  // Ã¢â€â‚¬Ã¢â€â‚¬ Step 5: Merge Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const result = passengerDocs
    .filter(p => p.rideId && rideMap.has(p.rideId.toString()))
    .map(p => {
      const ride = rideMap.get(p.rideId!.toString())!;
      const booking = bookingMap.get(p._id.toString());

      return {
        // Passenger
        userId,
        passengerId: p._id,
        requestedSeats: p.requestedSeats,
        estimatedFare: p.estimatedFare,
        pickup: p.pickup,
        destination: p.destination,
        departureDate: p.departureDate,
        departureTime: p.departureTime,

        // Booking
        bookingId: booking?._id || null,
        bookingShortId: booking?.id || null,
        paymentStatus: booking?.paymentStatus || null,

        // Ride
        rideId: ride._id,
        rideType: ride.type,
        rideStatus: ride.status,

        // Driver
        driver: ride.driverId || null,
      };
    });

  // Ã¢â€â‚¬Ã¢â€â‚¬ Step 6: Pagination Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
        bookingId: booking?._id || null,
        bookingShortId: booking?.id || null,
        paymentStatus: booking?.paymentStatus || passenger.paymentStatus,
        bookingStatus: booking?.bookingStatus || null,
        fareBreakdown: await buildStoredFareBreakdown(passenger, booking),
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
  const invoiceSettings = await Setting.find({
    key: { $in: ['platformCommissionPercent', 'platformVat'] },
  }).lean();
  const invoiceSettingMap = new Map(
    invoiceSettings.map((setting: any) => [setting.key, Number(setting.value)])
  );
  const platformFeePercent = invoiceSettingMap.get('platformCommissionPercent') ?? 0;
  const vatPercent = invoiceSettingMap.get('platformVat') ?? 0;

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
    totals: {
      passengerCount: passengers.length,
      bookingCount: bookings.length,
      paymentCount: payments.length,
      totalPassengerPaid,
      totalAuthorizedAmount,
      totalAmountToCapture,
      platformFeePercent,
      platformFeeAmount: roundMoney((ride as any).platformCommissionAmount || paymentPlatformCommission),
      paymentPlatformCommission,
      vatPercent,
      driverEarning: roundMoney((ride as any).driverEarningAmount || paymentProviderEarning),
      paymentProviderEarning,
      driverEarningCredited: Boolean((ride as any).driverEarningCredited),
      driverEarningCreditedAt: (ride as any).driverEarningCreditedAt || null,
      totalCollectedAmount: roundMoney((ride as any).totalCollectedAmount || totalPassengerPaid),
      currentSurchargePercent: (ride as any).currentSurchargePercent || 0,
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
export const RideService = {
  getAllIntoDB,
  getDriverRides,
  getRiderRides,
  getRideById,
};




