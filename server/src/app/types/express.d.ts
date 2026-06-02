// src/types/express.d.ts

import { Request } from 'express';
import { TFunction } from 'i18next'; // Import the TFunction type from i18next

declare global {
  namespace Express {
    interface Request {
      t: TFunction; // Add the 't' method to the Request object
    }
  }
}
