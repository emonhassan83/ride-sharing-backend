import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import path from 'path';
import { Morgan } from './app/utils/morgen';
import i18next from './app/i18n/i18n';
import router from './app/routes';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import notFound from './app/middlewares/notFount';

const app = express();

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
  res.status(201).json({ message: req.t('welcome') });
});

app.get('/test/:lang', (req: Request, res: Response) => {
  const { lang } = req.params;

  // Change the language dynamically for the current request
  i18next.changeLanguage(lang as string); // Switch language

  console.log(`Current language: ${i18next.language}`); // Log the current language

  // Send the translated response
  res.status(200).json({ message: req.t('welcome') }); // Get translated 'welcome' message
});

// global error handle
app.use(globalErrorHandler);

// handle not found route
app.use(notFound);

export default app;
