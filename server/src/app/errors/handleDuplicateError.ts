// handleDuplicateError.ts
import { IErrorMessage } from '../types/errors.types';

const handleDuplicateError = (error: any) => {
  const errorMessages: IErrorMessage[] = [
    {
      path: error.keyValue ? Object.keys(error.keyValue)[0] : 'unknown',
      message: `${Object.keys(error.keyValue)[0]} already exists`,
    },
  ];

  const code = 409;
  return {
    code,
    message: 'Duplicate entry detected',
    errorMessages,
  };
};

export default handleDuplicateError;
