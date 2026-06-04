import { ZodError } from 'zod';
import { IErrorMessage } from '../types/errors.types';

const handleZodError = (error: ZodError) => {
  const errorMessages: IErrorMessage[] = error.issues.map(el => {
    return {
      path: String(el.path[el.path.length - 1]), 
      message: el.message,
    };
  });

  const code = 400;
  return {
    code,
    message: 'Zod Validation Error',
    errorMessages,
  };
};

export default handleZodError;
