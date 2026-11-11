import { NextFunction, Request, Response } from 'express';
import status from 'http-status-codes';
import { translateText } from '../i18n/i18n';

const notFound = (req: Request, res: Response, next: NextFunction) => {
  const lang = res?.locals?.language || (req as any)?.language;
  const rawMessage = `The requested ${req.originalUrl} endpoint not found!`;
  const errorDetails = {
    success: false,
    message: translateText(rawMessage, lang),
    error: translateText(rawMessage, lang),
  };
  // Send a detailed response for easier debugging
  res.status(status.NOT_FOUND).json(errorDetails);
};

export default notFound;
