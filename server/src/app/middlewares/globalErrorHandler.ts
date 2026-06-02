import { ErrorRequestHandler } from 'express';
import ApiError from '../errors/ApiError';
import handleDuplicateError from '../errors/handleDuplicateError';
import handleValidationError from '../errors/handleValidationError';
import handleZodError from '../errors/handleZodError';
import { errorLogger } from '../config/logger.config';
import { IErrorMessage } from '../types/errors.types';
import { config } from '../config/env.config';

const globalErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  // Log error
  config.environment === 'development'
    ? console.log('🚨 globalErrorHandler ~~ ', error)
    : errorLogger.error('🚨 globalErrorHandler ~~ ', error);

  let code = 500;
  let message = 'Something went wrong';
  let errorMessages: IErrorMessage[] = [];

  // Handle ZodError
  if (error.name === 'ZodError') {
    const simplifiedError = handleZodError(error);
    code = simplifiedError.code;
    message = `${simplifiedError.errorMessages
      .map(err => err.message)
      .join(', ')}`;
    errorMessages = simplifiedError.errorMessages;
  }
  // Handle ValidationError (e.g., Mongoose)
  else if (error.name === 'ValidationError') {
    const simplifiedError = handleValidationError(error);
    code = simplifiedError.code;
    message = `${simplifiedError.errorMessages
      .map(err => err.message)
      .join(', ')}`;
    errorMessages = simplifiedError.errorMessages;
  }
  // Handle DuplicateError (e.g., from database unique constraint violation)
  else if (error.name === 'DuplicateError') {
    const simplifiedError = handleDuplicateError(error);
    code = simplifiedError.code;
    message = `${simplifiedError.errorMessages
      .map(err => err.message)
      .join(', ')}`;
    errorMessages = simplifiedError.errorMessages;
  }
  // Handle ApiError (custom error type)
  else if (error instanceof ApiError) {
    code = error.code;
    message = error.message || 'Something went wrong';
    errorMessages = error.message
      ? [
          {
            path: '',
            message: error.message,
          },
        ]
      : [];
  }
  // Handle other general errors
  else if (error instanceof Error) {
    message = error.message || 'Internal Server Error';
    errorMessages = error.message
      ? [
          {
            path: '',
            message: error.message,
          },
        ]
      : [];
  }

  // Format multiple error messages as a comma-separated list in the message field
  const formattedMessage =
    errorMessages.length > 1
      ? errorMessages.map(err => err.message).join(', ')
      : message;

  // Send response with statusCode, success, message, and error
  res.status(code).json({
    code,
    message: `${formattedMessage}`,
    error: errorMessages, // Error details (path and message)
    stack: config.environment === 'development' ? error?.stack : undefined, // Stack trace in development mode
  });
};

export default globalErrorHandler;
