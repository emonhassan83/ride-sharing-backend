// src/app/socket/socket.event.ts
import { Socket } from 'socket.io';
import { TSocket } from './interface/socket.interface';

// Chat events
import { myChatListHandler } from './handlers/chat/myChatList.handler';
import { sendMessageHandler } from './handlers/chat/sendMessage.handler';
import { editMessageHandler } from './handlers/chat/editMessage.handler';
import { deleteMessageHandler } from './handlers/chat/deleteMessage.handler';
import { seenHandler } from './handlers/chat/seen.handler';
import { typingHandler } from './handlers/chat/typing.handler';
import { stopTypingHandler } from './handlers/chat/stopTyping.handler';

// Driver events
import { driverGoOnlineHandler } from './handlers/ride/driverGoOnline.handler';
import { driverGoOfflineHandler } from './handlers/ride/driverGoOffline.handler';
import { driverLocationUpdateHandler } from './handlers/ride/driverLocationUpdate.handler';
import { driverAcceptRideHandler } from './handlers/ride/driverAcceptRide.handler';
import { driverRejectRideHandler } from './handlers/ride/driverRejectRide.handler';
import { driverCancelRideHandler } from './handlers/ride/driverCancelRide.handler';
import { driverArrivedHandler } from './handlers/ride/driverArrived.handler';
import { driverStartTripHandler } from './handlers/ride/driverStartTrip.handler';
import { pickUpRideHandler } from './handlers/ride/pickUpRide.handler';
import { driverCompleteTripHandler } from './handlers/ride/driverCompleteTrip.handler';

// Passenger/Ride events
import { getNearbyDriversHandler } from './handlers/ride/getNearbyDrivers.handler';
import { rideRequestHandler } from './handlers/ride/rideRequest.handler';
import { rideCancelBeforeAcceptHandler } from './handlers/ride/rideCancelBeforeAccept.handler';
import { rideCancelAfterAcceptHandler } from './handlers/ride/rideCancelAfterAccept.handler';
import { submitRatingHandler } from './handlers/ride/submitRating.handler';

// Disconnect handler
import disconnectHandler from './handlers/disconnect.handler';

export const registerSocketEvents = (socket: Socket) => {
  const tSocket = socket as TSocket; // Cast to TSocket

  // ==================== CHAT EVENTS ====================
  tSocket.on('my-chat-list', (data, callback) =>
    myChatListHandler.call(tSocket, data, callback)
  );
  tSocket.on('send-message', (data, callback) =>
    sendMessageHandler.call(tSocket, data, callback)
  );
  tSocket.on('edit-message', (data, callback) =>
    editMessageHandler.call(tSocket, data, callback)
  );
  tSocket.on('delete-message', (data, callback) =>
    deleteMessageHandler.call(tSocket, data, callback)
  );
  tSocket.on('seen', (data, callback) =>
    seenHandler.call(tSocket, data, callback)
  );
  tSocket.on('typing', (data) => typingHandler.call(tSocket, data));
  tSocket.on('stop-typing', (data) => stopTypingHandler.call(tSocket, data));

  // ==================== RIDE EVENTS ====================

  // ---------- DRIVER EVENTS ----------
  // Driver Online/Offline
  tSocket.on('driver:go-online', (data, callback) =>
    driverGoOnlineHandler.call(tSocket, data, callback)
  );
  tSocket.on('driver:go-offline', (data, callback) =>
    driverGoOfflineHandler.call(tSocket, data, callback)
  );

  // Driver Location
  tSocket.on('driver:location-update', (data) =>
    driverLocationUpdateHandler.call(tSocket, data)
  );

  // Driver Ride Actions
  tSocket.on('driver:accept-ride', (data, callback) =>
    driverAcceptRideHandler.call(tSocket, data, callback)
  );
  tSocket.on('driver:reject-ride', (data, callback) =>
    driverRejectRideHandler.call(tSocket, data, callback)
  );
  tSocket.on('driver:cancel-ride', (data, callback) =>
    driverCancelRideHandler.call(tSocket, data, callback)
  );
  tSocket.on('driver:arrived-pickup', (data) =>
    driverArrivedHandler.call(tSocket, data)
  );
  tSocket.on('driver:start-trip', (data, callback) =>
    driverStartTripHandler.call(tSocket, data, callback)
  );
  tSocket.on('driver:pickup-ride', (data, callback) =>
    pickUpRideHandler.call(tSocket, data, callback)
  );
  tSocket.on('driver:complete-trip', (data, callback) =>
    driverCompleteTripHandler.call(tSocket, data, callback)
  );

  // ---------- PASSENGER/RIDER EVENTS ----------
  // Ride Search & Request
  tSocket.on('ride:get-nearby-drivers', (data, callback) =>
    getNearbyDriversHandler.call(tSocket, data, callback)
  );
  tSocket.on('ride:request', (data, callback) =>
    rideRequestHandler.call(tSocket, data, callback)
  );
  tSocket.on('ride:cancel-before-accept', (data, callback) =>
    rideCancelBeforeAcceptHandler.call(tSocket, data, callback)
  );
  tSocket.on('ride:cancel-after-accept', (data, callback) =>
    rideCancelAfterAcceptHandler.call(tSocket, data, callback)
  );

  // Rating
  tSocket.on('ride:submit-rating', (data, callback) =>
    submitRatingHandler.call(tSocket, data, callback)
  );

  // ==================== DISCONNECT ====================
  tSocket.on('disconnect', () => disconnectHandler.call(tSocket, undefined));
};

export default registerSocketEvents;
