import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { UserLocation } from './savedPlaces.model';
import { getCache, setCache, deleteCache } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

// ==================== CREATE SAVED PLACE ====================
const createSavedPlace = async (userId: string, payload: any) => {
  const existingCount = await UserLocation.countDocuments({ user: userId });
  if (existingCount >= 10) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'You can save maximum 10 places');
  }

  const savedPlace = await UserLocation.create({
    ...payload,
    user: userId,
  });

  // invalidate cache
  await deleteCache(REDIS_KEYS.SAVED_PLACES_BY_USER(userId));

  return savedPlace;
};

// ==================== GET MY SAVED PLACES ====================
const getMySavedPlaces = async (userId: string) => {
  const cacheKey = REDIS_KEYS.SAVED_PLACES_BY_USER(userId);
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const result = await UserLocation.find({ user: userId })
    .sort({ isPinned: -1, createdAt: -1 })
    .lean();

  await setCache(cacheKey, result);
  return result;
};

const togglePinSavedLocation = async (userId: string, placeId: string) => {
  const place = await UserLocation.findOne({ _id: placeId, user: userId });
  if (!place) throw new ApiError(StatusCodes.NOT_FOUND, 'Place not found');

  const newPinStatus = !place.isPinned;

  // If setting to pinned, remove pin from others
  if (newPinStatus) {
    await UserLocation.updateMany(
      { user: userId, isPinned: true, _id: { $ne: placeId } },
      { isPinned: false }
    );
  }

  place.isPinned = newPinStatus;
  await place.save();

  await deleteCache(REDIS_KEYS.SAVED_PLACES_BY_USER(userId));
  return place;
};

// ==================== UPDATE SAVED PLACE ====================
const updateSavedPlace = async (userId: string, placeId: string, payload: any) => {
  const place = await UserLocation.findOneAndUpdate(
    { _id: placeId, user: userId },
    payload,
    { new: true, runValidators: true }
  );
  if (!place) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Saved place not found');
  }

  // invalidate cache
  await deleteCache(REDIS_KEYS.SAVED_PLACES_BY_USER(userId));

  return place;
};

// ==================== DELETE SAVED PLACE ====================
const deleteSavedPlace = async (userId: string, placeId: string) => {
  const place = await UserLocation.findOneAndDelete({ _id: placeId, user: userId });
  if (!place) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Saved place not found');
  }

  // invalidate cache
  await deleteCache(REDIS_KEYS.SAVED_PLACES_BY_USER(userId));

  return place;
};

export const SavedPlaceService = {
  createSavedPlace,
  getMySavedPlaces,
  togglePinSavedLocation,
  updateSavedPlace,
  deleteSavedPlace
};
