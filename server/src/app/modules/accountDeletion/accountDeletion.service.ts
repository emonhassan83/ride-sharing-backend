import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import ApiError from '../../errors/ApiError';
import { AccountDeletion } from './accountDeletion.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { User } from '../user/user.model';
import { getCache, setCache, deleteCache, deleteCachePattern } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

// ==================== ADMIN - GET ALL ====================
const getAllDeletions = async (query: Record<string, any> = {}) => {
  // No list cache — searchTerm / page / limit must always hit DB
  const filter: Record<string, any> = {};

  const searchTerm =
    typeof query.searchTerm === 'string' ? query.searchTerm.trim() : '';

  if (searchTerm) {
    const userQuery: Record<string, any>[] = [
      { name: { $regex: searchTerm, $options: 'i' } },
      { email: { $regex: searchTerm, $options: 'i' } },
    ];

    // Match Mongo _id when searchTerm is a valid ObjectId string
    if (
      Types.ObjectId.isValid(searchTerm) &&
      String(new Types.ObjectId(searchTerm)) === searchTerm
    ) {
      userQuery.push({ _id: new Types.ObjectId(searchTerm) });
    }

    const matchedUsers = await User.find({ $or: userQuery }).select('_id').lean();
    const userIds = matchedUsers.map((u) => u._id);

    const deletionOr: Record<string, any>[] = [];
    if (userIds.length) {
      deletionOr.push({ user: { $in: userIds } });
    }
    if (
      Types.ObjectId.isValid(searchTerm) &&
      String(new Types.ObjectId(searchTerm)) === searchTerm
    ) {
      deletionOr.push({ _id: new Types.ObjectId(searchTerm) });
    }

    if (deletionOr.length) {
      filter.$or = deletionOr;
    } else {
      // No matches — force empty result (pagination meta still correct)
      filter._id = { $exists: false };
    }
  }

  const { searchTerm: _search, ...builderQuery } = query;

  const accountDeletion = new QueryBuilder(
    AccountDeletion.find(filter).populate([
      {
        path: 'user',
        select: '_id name email role profileImage createdAt',
      },
    ]),
    builderQuery,
  )
    .filter()
    .sort()
    .paginate()
    .fields();

  const data = await accountDeletion.modelQuery;
  const meta = await accountDeletion.countTotal();

  return { data, meta };
};

// ==================== ADMIN - GET SINGLE ====================
const getSingleDeletion = async (id: string) => {
  const cacheKey = REDIS_KEYS.ACCOUNT_DELETION_SINGLE(id);

  const cached = await getCache<any>(cacheKey);
  if (cached) return cached;

  const record = await AccountDeletion.findById(id).populate([
    {
      path: 'user',
      select:
        '_id name email profileImage phone countryCode address location createdAt',
    },
  ]);
  if (!record)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Deletion record not found');

  await setCache(cacheKey, record);

  return record;
};

// ==================== ADMIN - DELETE RECORD ====================
const deleteDeletionRecord = async (id: string) => {
  const record = await AccountDeletion.findByIdAndDelete(id);

  if (!record)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Deletion record not found');

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
