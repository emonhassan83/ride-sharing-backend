// src/app/socket/utils/eventHandler.ts
import { handleSocketError } from "./handleSocketError";
import { TAckFn, TSocket, TSocketHandler } from "../interface/socket.interface";

const eventHandler = <TData = any>(handler: TSocketHandler<TData>) => {
  return async function (this: TSocket, data: TData, ack?: TAckFn) {
    try {
      if (!this || typeof this.emit !== 'function') {
        console.error('❌ Invalid socket context in eventHandler');
        return;
      }

      console.log(`🔧 eventHandler executing for event with ack type: ${typeof ack}`);

      await handler(this, data, ack);
    } catch (err: unknown) {
      console.error('❌ Error caught in eventHandler:', err);
      if (this && typeof this.emit === 'function') {
        handleSocketError(err, this, ack);
      }
    }
  };
};

export default eventHandler;