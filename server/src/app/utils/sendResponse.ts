import { Response } from 'express';
import { translateText } from '../i18n/i18n';

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
  const lang = res?.locals?.language || (res?.req as any)?.language;
  const translatedMessage = data.message
    ? translateText(data.message, lang)
    : data.message;

  const resData = {
    code: data.code,
    message: translatedMessage,
    pagination: data.pagination,
    data: data.data,
    extra: data.extra,
    cached: data.cached,
  };
  res.status(data.code).json(resData);
};

export default sendResponse;
