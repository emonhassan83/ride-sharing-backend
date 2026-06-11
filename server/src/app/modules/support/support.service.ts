import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { TSupport, TSupportMessage } from './support.interface';
import { Support } from './support.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { TSupportStatus } from './support.constant';
import { User } from '../user/user.model';
import { getEmailQueueInstance } from '../../utils/queueHelper';
import {
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
} from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

const create = async (userId: string, payload: Partial<TSupport>) => {
  const author = await User.findById(userId);
  if (!author || author?.isDeleted) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'This user is not found !');
  }

  payload.user = author._id;
  payload.email = author.email;

  const result = await Support.create(payload);

  // invalidate cache
  await deleteCache(REDIS_KEYS.SUPPORT_ALL);
  await deleteCachePattern('support:*');

  return result;
};

const getAll = async (query: Record<string, any>) => {
  const cacheKey = REDIS_KEYS.SUPPORT_ALL;

  // 1. Try cache
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    console.log('✅ Cache hit for support tickets');
    return cached;
  }

  console.log('📡 Cache miss for support tickets, fetching from DB...');

  const supportModel = new QueryBuilder(
    Support.find().populate([
      { path: 'user', select: 'name phone email profileImage' },
    ]),
    query
  )
    .search(['id'])
    .filter()
    .paginate()
    .sort()
    .fields();

  const data = await supportModel.modelQuery;
  const meta = await supportModel.countTotal();

  const response = { data, meta };

  // 2. Set cache
  await setCache(cacheKey, response);

  return response;
};

const sentSupportMessage = async (id: string, payload: TSupportMessage) => {
  const support = await Support.findById(id);
  if (!support) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'This Support is not found !');
  }

  const emailQueue = await getEmailQueueInstance();
  await emailQueue.add(
    'send-support-reply-email',
    {
      support,
      subject: payload.subject,
      message: payload.messages,
    },
    {
      priority: 1,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    }
  );

  const result = await Support.findByIdAndUpdate(
    id,
    {
      $set: {
        status: payload.status,
        contractBy: payload.contractBy,
      },
    },
    { new: true }
  );

  // invalidate cache
  await deleteCache(REDIS_KEYS.SUPPORT_ALL);
  await deleteCache(REDIS_KEYS.SUPPORT_SINGLE(id));

  return result;
};

const changeStatus = async (
  id: string,
  payload: { status: TSupportStatus }
) => {
  const { status } = payload;
  const support = await Support.findById(id);
  if (!support) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'This Support is not found !');
  }

  const result = await Support.findByIdAndUpdate(
    id,
    { $set: { status } },
    { new: true }
  );

  // invalidate cache
  await deleteCache(REDIS_KEYS.SUPPORT_ALL);
  await deleteCache(REDIS_KEYS.SUPPORT_SINGLE(id));

  return result;
};

const remove = async (id: string) => {
  const report = await Support.findByIdAndDelete(id).lean();
  if (!report) throw new ApiError(StatusCodes.NOT_FOUND, 'Report not found');

  // invalidate cache
  await deleteCache(REDIS_KEYS.SUPPORT_ALL);
  await deleteCache(REDIS_KEYS.SUPPORT_SINGLE(id));
};

export const SupportService = {
  create,
  getAll,
  sentSupportMessage,
  changeStatus,
  remove,
};
