// src/utils/emitToParticipants.ts
import onlineUsers from './onlineUsers';
import { Socket } from 'socket.io';

export const emitToParticipants = (
  participantIds: string[],
  event: string,
  payload: unknown
) => {
  participantIds.forEach(participantId => {
    const participantSocket = onlineUsers[participantId] as Socket;
    if (participantSocket) {
      participantSocket.emit(event, payload);
    }
  });
};