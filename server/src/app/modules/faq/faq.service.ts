import httpStatus from 'http-status';
import ApiError from '../../errors/ApiError';
import { Faq } from './faq.model';
import { getCache, setCache, deleteCache, deleteCachePattern } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';
import { TFaq } from './faq.interface';

const createFaqIntoDB = async (payload: TFaq) => {
  const faq = await Faq.create(payload);
  if (!faq) {
    throw new ApiError(httpStatus.CONFLICT, 'Faq not created!');
  }

  // invalidate cache
  await deleteCache(REDIS_KEYS.FAQ_ALL);
  await deleteCachePattern('faq:*');

  return faq;
};

const getAllFaqsFromDB = async (query: Record<string, unknown>) => {
  const audience = query.audience as string | undefined;
  const cacheKey = audience ? REDIS_KEYS.FAQ_BY_AUDIENCE(audience) : REDIS_KEYS.FAQ_ALL;

  // 1. Try cache
  const cached = await getCache<any[]>(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for FAQs: ${audience || 'all'}`);
    return cached;
  }

  console.log(`📡 Cache miss for FAQs: ${audience || 'all'}, fetching from DB...`);

  // 2. DB query
  const filter: any = {};
  if (audience) filter.audience = audience;

  const result = await Faq.find(filter).sort({ createdAt: -1 }).lean();

  // 3. Set cache
  await setCache(cacheKey, result);

  return result;
};

const updateFaqFromDB = async (id: string, payload: Partial<TFaq>) => {
  const faq = await Faq.findById(id);
  if (!faq) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Faq not found');
  }

  const updatedFaq = await Faq.findByIdAndUpdate(id, payload, { returnDocument: 'after' });
  if (!updatedFaq) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Faq not updated');
  }

  // invalidate cache
  await deleteCache(REDIS_KEYS.FAQ_ALL);
  await deleteCachePattern('faq:*');

  return updatedFaq;
};

const deleteAFaqFromDB = async (id: string) => {
  const faq = await Faq.findById(id);
  if (!faq) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Faq not found');
  }

  const result = await Faq.findByIdAndDelete(id);
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Faq delete failed');
  }

  // invalidate cache
  await deleteCache(REDIS_KEYS.FAQ_ALL);
  await deleteCachePattern('faq:*');

  return result;
};

export const FaqService = {
  createFaqIntoDB,
  getAllFaqsFromDB,
  updateFaqFromDB,
  deleteAFaqFromDB,
};
