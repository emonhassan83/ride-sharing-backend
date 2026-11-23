// server/src/services/socket-notification.service.ts
import { logger } from '../configs/logger.configs';

/**
 * Stub: the worker process has no Socket.io server, so it cannot emit to users.
 * Real-time delivery is done by the server. It reports `{ success: false }`
 * instead of throwing, so a caller can fall back to another channel.
 */
export const sendSocketNotification = async (
  userId: string,
  payload: {
    type: string;
    title: string;
    message: string;
    data?: any;
  }
): Promise<{ success: boolean }> => {
  //! TODO: FOR SOCKET USE REDIS PUB SUB
  logger.warn(
    `Socket.io not initialized in the worker | User: ${userId} | Type: ${payload.type}`
  );
  return { success: false };
};
