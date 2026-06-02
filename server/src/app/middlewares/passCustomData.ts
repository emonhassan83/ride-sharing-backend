import { NextFunction, Request, Response } from 'express';
import catchAsync from '../utils/catchAsync';

const passCustomData = (customData: any) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    req.body = { ...req.body, ...customData }; // Attach custom data to the request object
    next(); // Pass control to the next middleware
  });



export default passCustomData;
