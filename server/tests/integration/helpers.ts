/**
 * Shared helpers for the real-service integration tests: a raw Socket.io v5 client
 * over `ws` (acks, connect errors, event log) and a small HTTP helper.
 */
import WebSocket from 'ws';

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RawClient = Awaited<ReturnType<typeof connectClient>>;

export async function connectClient(port: number, token: string, headers: Record<string, string> = {}) {
  const events: Array<[string, any]> = [];
  const acks = new Map<number, (data: any) => void>();
  let nextAck = 1;
  let closed = false;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', () => {
      closed = true;
    });
    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg.startsWith('0{')) ws.send(`40${JSON.stringify({ token })}`);
      else if (msg === '2') ws.send('3');
      else if (msg.startsWith('40')) resolve();
      else if (msg.startsWith('44')) reject(new Error(JSON.parse(msg.slice(2)).message));
      else if (msg.startsWith('43')) {
        const m = /^43(\d+)([\s\S]*)$/.exec(msg);
        if (m) acks.get(Number(m[1]))?.(JSON.parse(m[2])[0]);
      } else if (msg.startsWith('42')) {
        const [event, data] = JSON.parse(msg.slice(2));
        events.push([event, data]);
      }
    });
  });
  return {
    socketEvents: events,
    get closed() {
      return closed;
    },
    request(event: string, data: unknown, timeoutMs = 8000): Promise<any> {
      const id = nextAck++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), timeoutMs);
        acks.set(id, (d) => {
          clearTimeout(timer);
          resolve(d);
        });
        ws.send(`42${id}${JSON.stringify([event, data])}`);
      });
    },
    named(event: string) {
      return events.filter(([e]) => e === event).map(([, d]) => d);
    },
    async waitFor(event: string, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const hit = events.find(([e]) => e === event);
        if (hit) return hit[1];
        await wait(25);
      }
      throw new Error(`event ${event} not received`);
    },
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  };
}

export const apiFor =
  (getPort: () => number) =>
  (path: string, init: RequestInit & { token?: string; lang?: string } = {}) =>
    fetch(`http://127.0.0.1:${getPort()}/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.lang ? { language: init.lang } : {}),
        ...(init.headers as any),
      },
    });

/** Wall-clock date/time in the ride timezone (Europe/Nicosia). */
export const localParts = (d: Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Nicosia',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
