import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Types } from 'mongoose';
import { TVehicle } from './vehicle.interface';
import { Vehicle } from './vehicle.model';
import { getCache, setCache, deleteCache } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

const validateObjectId = (id: string, label = 'ID') => {
  if (!Types.ObjectId.isValid(id))
    throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid ${label}`);
};

const addMultipleCars = async (userId: string, payloads: Partial<TVehicle>[]) => {
  if (!payloads || !payloads.length) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'No vehicles provided');
  }

  // Normalize plate numbers
  const numbers = payloads
    .map(p => p.number?.toUpperCase())
    .filter((n): n is string => !!n);

  if (!numbers.length) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Valid vehicle numbers are required');
  }

  // Check duplicates in DB
  const existing = await Vehicle.find({ number: { $in: numbers } });
  if (existing.length > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `Duplicate plate numbers found: ${existing.map(e => e.number).join(', ')}`
    );
  }

  // Check if user already has cars
  const hasCars = await Vehicle.exists({ userId, isDeleted: false });

  // Prepare vehicles
  const vehicles = payloads.map((p, index) => ({
    ...p,
    userId,
    number: p.number?.toUpperCase(),
    isDefault: !hasCars && index === 0, // প্রথম গাড়ি default হবে যদি আগে কোনো গাড়ি না থাকে
  }));

  // Bulk insert
  const inserted = await Vehicle.insertMany(vehicles);

  // Invalidate cache
  await deleteCache(REDIS_KEYS.VEHICLES_BY_USER(userId));

  return inserted;
};

// ── Add a car ───────────────────────────────────────────────
const addACar = async (userId: string, payload: Partial<TVehicle>) => {
  const existing = await Vehicle.findOne({
    number: payload.number?.toUpperCase(),
  });
  if (existing)
    throw new ApiError(StatusCodes.CONFLICT, 'A car with this plate number already exists');

  const hasCars = await Vehicle.exists({ userId, isDeleted: false });

  const vehicle = await Vehicle.create({
    ...payload,
    userId,
    isDefault: !hasCars,
  });

  // invalidate cache
  await deleteCache(REDIS_KEYS.VEHICLES_BY_USER(userId));

  return vehicle;
};

// ── Get my cars ─────────────────────────────────────────────
const getMyCars = async (userId: string) => {
  const cacheKey = REDIS_KEYS.VEHICLES_BY_USER(userId);

  // 1. Try cache
  const cached = await getCache<any[]>(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for vehicles of user ${userId}`);
    return cached;
  }

  console.log(`📡 Cache miss for vehicles of user ${userId}, fetching from DB...`);

  const vehicles = await Vehicle.find({ userId, isDeleted: false })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  if (!vehicles.length)
    throw new ApiError(StatusCodes.NOT_FOUND, 'No cars found');

  // 2. Set cache
  await setCache(cacheKey, vehicles);

  return vehicles;
};

// ── Update a car ────────────────────────────────────────────
const updateACar = async (userId: string, carId: string, payload: Partial<TVehicle>) => {
  validateObjectId(carId, 'car ID');
  delete (payload as any).isDefault;

  if (payload.number) {
    const duplicate = await Vehicle.findOne({
      number: payload.number.toUpperCase(),
      _id: { $ne: carId },
    });
    if (duplicate)
      throw new ApiError(StatusCodes.CONFLICT, 'A car with this plate number already exists');
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: carId, userId, isDeleted: false },
    payload,
    { returnDocument: 'after', runValidators: true },
  ).lean();

  if (!vehicle)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Car not found or does not belong to you');

  // invalidate cache
  await deleteCache(REDIS_KEYS.VEHICLES_BY_USER(userId));

  return vehicle;
};

// ── Set as default ──────────────────────────────────────────
const setAsDefault = async (userId: string, carId: string) => {
  validateObjectId(carId, 'car ID');

  const car = await Vehicle.findOne({ _id: carId, userId, isDeleted: false });
  if (!car)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Car not found or does not belong to you');

  if (car.isDefault)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This car is already set as default');

  await Vehicle.updateMany({ userId }, { isDefault: false });
  car.isDefault = true;
  await car.save();

  // invalidate cache
  await deleteCache(REDIS_KEYS.VEHICLES_BY_USER(userId));

  return car;
};

// ── Delete a car ────────────────────────────────────────────
const deleteACar = async (userId: string, carId: string) => {
  validateObjectId(carId, 'car ID');

  const car = await Vehicle.findOne({ _id: carId, userId, isDeleted: false });
  if (!car)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Car not found or does not belong to you');

  car.isDeleted = true;

  if (car.isDefault) {
    const next = await Vehicle.findOne({
      userId,
      _id: { $ne: carId },
      isDeleted: false,
    }).sort({ createdAt: -1 });

    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }

  await car.save();

  // invalidate cache
  await deleteCache(REDIS_KEYS.VEHICLES_BY_USER(userId));
};

export const VehicleService = {
  addMultipleCars,
  addACar,
  getMyCars,
  updateACar,
  setAsDefault,
  deleteACar,
};
