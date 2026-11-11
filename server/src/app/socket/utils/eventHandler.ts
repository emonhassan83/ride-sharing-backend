// src/app/socket/utils/eventHandler.ts
import { handleSocketError } from "./handleSocketError";
import { TAckFn, TSocket, TSocketHandler } from "../interface/index.interface";
import {
  normalizeLanguage,
  runWithLanguage,
  translateText,
} from "../../i18n/i18n";

const eventHandler = <TData = any>(handler: TSocketHandler<TData>) => {
  return async function (this: TSocket, data: TData, ack?: TAckFn) {
    const socketLang = normalizeLanguage(
      (this as any)?.auth?.language ||
        this?.handshake?.auth?.language ||
        (this?.handshake?.headers?.['language'] as string) ||
        (this?.handshake?.headers?.['accept-language'] as string),
    );

    const localizedAck: TAckFn | undefined =
      typeof ack === 'function'
        ? (res: any) => {
            if (res && typeof res === 'object' && typeof res.message === 'string') {
              res = {
                ...res,
                message: translateText(res.message, socketLang),
              };
            }
            ack(res);
          }
        : undefined;

    try {
      if (!this || typeof this.emit !== 'function') {
        console.error('❌ Invalid socket context in eventHandler');
        return;
      }

      console.log(`🔧 eventHandler executing for event with ack type: ${typeof ack}`);

      await runWithLanguage(socketLang, () =>
        handler(this, data, localizedAck),
      );
    } catch (err: unknown) {
      console.error('❌ Error caught in eventHandler:', err);
      if (this && typeof this.emit === 'function') {
        runWithLanguage(socketLang, () =>
          handleSocketError(err, this, localizedAck),
        );
      }
    }
  };
};

export default eventHandler;