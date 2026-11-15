import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import ApiError from '../../errors/ApiError';
import { AccountDeletion } from './accountDeletion.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { User } from '../user/user.model';
import { TUserRole, USER_ROLE } from '../user/user.constant';
import { getCache, setCache, deleteCache, deleteCachePattern } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

const isUserRole = (value: string): value is TUserRole =>
  (Object.values(USER_ROLE) as string[]).includes(value);

// ==================== ADMIN - GET ALL ====================
const getAllDeletions = async (query: Record<string, any> = {}) => {
  // No list cache — searchTerm / role / page / limit must always hit DB
  const filter: Record<string, any> = {};
  const andConditions: Record<string, any>[] = [];

  const searchTerm =
    typeof query.searchTerm === 'string' ? query.searchTerm.trim() : '';
  const roleRaw =
    typeof query.role === 'string' ? query.role.trim() : '';
  const role: TUserRole | null = isUserRole(roleRaw) ? roleRaw : null;

  // role lives on User, not AccountDeletion — resolve user ids first
  if (roleRaw) {
    if (!role) {
      // Unknown role → empty page
      filter._id = { $exists: false };
    } else {
      const roleUsers = await User.find({ role })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>();
      const roleUserIds = roleUsers.map((u) => u._id);
      if (!roleUserIds.length) {
        filter._id = { $exists: false };
      } else {
        andConditions.push({ user: { $in: roleUserIds } });
      }
    }
  }

  if (searchTerm && !filter._id) {
    const userQuery: Record<string, any>[] = [
      { name: { $regex: searchTerm, $options: 'i' } },
      { email: { $regex: searchTerm, $options: 'i' } },
    ];

    if (
      Types.ObjectId.isValid(searchTerm) &&
      String(new Types.ObjectId(searchTerm)) === searchTerm
    ) {
      userQuery.push({ _id: new Types.ObjectId(searchTerm) });
    }

    // If role already scoped users, search within that role only
    const matchedUsers = await User.find({
      $or: userQuery,
      ...(role ? { role } : {}),
    } as any)
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>();

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
      andConditions.push({ $or: deletionOr });
    } else {
      filter._id = { $exists: false };
    }
  }

  if (andConditions.length && !filter._id) {
    filter.$and = andConditions;
  }

  // role/searchTerm are not AccountDeletion document fields
  const { searchTerm: _search, role: _role, ...builderQuery } = query;

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
        '_id name email role profileImage phone countryCode address location createdAt',
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
