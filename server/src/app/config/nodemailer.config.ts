import colors from 'colors';
import { config } from '../config/env.config';
import nodemailer from 'nodemailer';
import { errorLogger, logger } from './logger.config';
import { ISendEmail } from '../types/email';

// Create Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: Number(config.smtp.port),
  secure: config.smtp.secure, // true for 465, false for 587/STARTTLS
  auth: {
    user: config.smtp.username,
    pass: config.smtp.password,
  },
});

// Verify transporter connection
if (config.environment !== 'test') {
  transporter
    .verify()
    .then(() => logger.info(colors.cyan('📧  Connected to email server')))
    .catch(err =>
      logger.warn(
        'Unable to connect to email server. Make sure you have configured the SMTP options in .env'
      )
    );
}

// Function to send email
export const sendEmail = async (values: ISendEmail) => {
  try {
    const info = await transporter.sendMail({
      from: `${config.smtp.emailFrom}`, // sender address
      to: values.to, // list of receivers
      subject: values.subject, // subject line
      html: values.html, // html body
    });
    logger.info('Mail sent successfully', info.accepted);
  } catch (error) {
    errorLogger.error('Email', error);
  }
};
