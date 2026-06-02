import { Response } from 'express';

type IData<T> = {
  code: number;
  message?: string;
  data?: T;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPage: number;
  };
  extra?: any;
  cached?: boolean;
};

const sendResponse = <T>(res: Response, data: IData<T>) => {
  const resData = {
    code: data.code,
    message: data.message,
    pagination: data.pagination,
    data: data.data,
    extra: data.extra,
    cached: data.cached,
  };
  res.status(data.code).json(resData);
};

export default sendResponse;
