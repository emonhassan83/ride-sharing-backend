import { NextFunction, Request, RequestHandler, Response } from 'express';

const catchAsync =
  (fn: RequestHandler) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      console.log(req.body);
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };

export default catchAsync;
