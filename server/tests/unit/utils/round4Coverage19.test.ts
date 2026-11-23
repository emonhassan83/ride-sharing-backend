/** B-19: accepted-ride push text for scheduled rides vs imminent rides. */
import { describe, expect, it } from 'vitest';
import { buildAcceptedPushDescription } from '@src/app/socket/handlers/ride/driverAcceptRide.handler';

const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return { departureDate: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, departureTime: `${p(d.getHours())}:${p(d.getMinutes())}` };
};
const ETA = 'Your driver is on the way. ETA: 6 minutes.';

describe('buildAcceptedPushDescription', () => {
  it('ride hours away -> confirmed-for text, no ETA', () => {
    const r = fmt(new Date(Date.now() + 5 * 3600_000));
    const text = buildAcceptedPushDescription(r, ETA);
    expect(text).toContain('Your ride is confirmed for');
    expect(text).not.toContain('ETA');
  });
  it('ride in 10 minutes -> ETA text', () => {
    expect(buildAcceptedPushDescription(fmt(new Date(Date.now() + 10 * 60_000)), ETA)).toBe(ETA);
  });
  it('missing / malformed schedule falls back to ETA text', () => {
    expect(buildAcceptedPushDescription(null, ETA)).toBe(ETA);
    expect(buildAcceptedPushDescription({}, ETA)).toBe(ETA);
    expect(buildAcceptedPushDescription({ departureDate: 'garbage', departureTime: 'x' }, ETA)).toBe(ETA);
  });
});
