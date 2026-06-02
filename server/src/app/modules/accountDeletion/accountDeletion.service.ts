import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { AccountDeletion } from './accountDeletion.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { getCache, setCache, deleteCache, deleteCachePattern } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

// ==================== ADMIN - GET ALL ====================
const getAllDeletions = async (query: any = {}) => {
  const cacheKey = REDIS_KEYS.ACCOUNT_DELETION_ALL;

  // 1. Try cache
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    console.log('✅ Cache hit for account deletions');
    return cached;
  }

  console.log('📡 Cache miss for account deletions, fetching from DB...');

  const accountDeletion = new QueryBuilder(
    AccountDeletion.find().populate([
      {
        path: 'user',
        select: '_id name email profileImage createdAt',
      },
    ]),
    query
  )
    .search([''])
    .filter()
    .sort()
    .paginate()
    .fields();

  const result = await accountDeletion.modelQuery;
  const meta = await accountDeletion.countTotal();

  const response = { meta, result };

  // 2. Set cache
  await setCache(cacheKey, response);

  return response;
};

// ==================== ADMIN - GET SINGLE ====================
const getSingleDeletion = async (id: string) => {
  const cacheKey = REDIS_KEYS.ACCOUNT_DELETION_SINGLE(id);

  // 1. Try cache
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for deletion record ${id}`);
    return cached;
  }

  console.log(`📡 Cache miss for deletion record ${id}, fetching from DB...`);

  const record = await AccountDeletion.findById(id).populate([
    {
      path: 'user',
      select:
        '_id name email profileImage phone countryCode address location createdAt',
    },
  ]);
  if (!record)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Deletion record not found');

  // 2. Set cache
  await setCache(cacheKey, record);

  return record;
};

// ==================== ADMIN - DELETE RECORD ====================
const deleteDeletionRecord = async (id: string) => {
  const record = await AccountDeletion.findByIdAndDelete(id);

  if (!record)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Deletion record not found');

  // invalidate cache
  await deleteCache(REDIS_KEYS.ACCOUNT_DELETION_SINGLE(id));
  await deleteCache(REDIS_KEYS.ACCOUNT_DELETION_ALL);
  await deleteCachePattern('accountDeletion:*');

  return record;
};

export const AccountDeletionService = {
  getAllDeletions,
  getSingleDeletion,
  deleteDeletionRecord,
};
