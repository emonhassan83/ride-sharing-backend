import path from 'path';

import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '../../../.env') });

export const getEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing Environment Variable: ${key}`);
  }
  return value as string;
};
