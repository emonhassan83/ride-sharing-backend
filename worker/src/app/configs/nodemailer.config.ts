import { type TransportOptions, createTransport } from 'nodemailer';

import { env } from '@/env';
import { ISendEmail } from '../@types/system.types';
import { errorLogger, logger } from './logger.configs';

const transporter = createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465 ? true : false,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
} as TransportOptions);


export const sendEmail = async (values: ISendEmail) => {
  try {
    const info = await transporter.sendMail({
      from: `${env.SMTP_USER}`, // sender address
      to: values.to, // list of receivers
      subject: values.subject, // subject line
      html: values.html, // html body
    });
    logger.info('Mail sent successfully', info.accepted);
  } catch (error) {
    errorLogger.error('Email', error);
  }
};
