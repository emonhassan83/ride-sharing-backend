import { Server } from 'socket.io';

/**
 * `io.emit('onlineUser', count)` goes to EVERY connected socket. Called on each
 * driver go-online / go-offline it is O(drivers x sockets): the T2 load test
 * (1000 drivers, 3000 riders) delivered ~2 million of these events in ~3 min.
 * Coalesce bursts into one trailing broadcast per interval; clients still get
 * the latest count within `BROADCAST_INTERVAL_MS`.
 */
const BROADCAST_INTERVAL_MS = 1000;
let timer: NodeJS.Timeout | null = null;

export const broadcastOnlineCount = (
  io: Server,
  readCount: () => Promise<number>
): void => {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      io.emit('onlineUser', await readCount());
    } catch {
      /* best-effort broadcast */
    }
  }, BROADCAST_INTERVAL_MS);
  timer.unref?.();
};
