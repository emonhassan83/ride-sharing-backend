import './app/config/zod.config'; // global Zod messages; must load before any schema is used
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import path from 'path';
import { Morgan } from './app/utils/morgen';
import router from './app/routes';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import notFound from './app/middlewares/notFount';
import { i18nMiddleware, translateText } from './app/i18n/i18n';

const app = express();

// Behind the TLS reverse proxy (docs/DEPLOYMENT.md) set TRUST_PROXY=1 so req.ip,
// req.protocol and req.secure reflect the client, not the proxy. Off by default.
if (process.env.TRUST_PROXY) {
  const raw = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw);
}

// i18n language detection & context middleware
app.use(i18nMiddleware);

// morgan
app.use(Morgan.successHandler);
app.use(Morgan.errorHandler);

// body parser
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Use cookie-parser to parse cookies
app.use(cookieParser());

// file retrieve
app.use('/uploads', express.static(path.join(__dirname, '../uploads/')));

// router
app.use('/api/v1', router);

// live response
app.get('/', (req: Request, res: Response) => {
  res
    .status(201)
    .json({
      message: translateText('Welcome to SplitRide!', (req as any).language),
      status: 'success',
      timestamp: new Date().toISOString()
    });
});

// global error handle
app.use(globalErrorHandler);

// handle not found route
app.use(notFound);

export default app;
