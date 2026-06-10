// server/src/services/socket-notification.service.ts
import { logger } from '../configs/logger.configs';

export const sendSocketNotification = async (
  userId: string,
  payload: {
    type: string;
    title: string;
    message: string;
    data?: any;
  }
): Promise<{ success: boolean }> => {
  try {
    //! TODO: FOR SOCKET USE REDIS PUB SUB
    // @ts-ignore
    const io = getIO();
    if (!io) {
      logger.warn('Socket.io not initialized');
      return { success: false };
    }
    
    // Emit to user's specific room
    io.to(`user_${userId}`).emit('notification', {
      id: `${payload.type}_${Date.now()}`,
      title: payload.title,
      message: payload.message,
      data: payload.data,
      timestamp: new Date(),
      read: false,
    });
    
    // Optional: Store in database for offline users
    // await Notification.create({
    //   userId,
    //   type: payload.type,
    //   title: payload.title,
    //   message: payload.message,
    //   data: payload.data,
    //   read: false,
    // });
    
    logger.info(`📡 Socket notification | User: ${userId} | Type: ${payload.type}`);
    
    return { success: true };
  } catch (error) {
    logger.error(`Socket notification failed for user ${userId}:`, error);
    throw error;
  }
};