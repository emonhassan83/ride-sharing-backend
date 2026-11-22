import { describe, it, vi } from 'vitest';
import fs from 'node:fs';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import { Setting } from '@src/app/modules/settings/settings.model';
import { getRideTimeZone, getMinBookingLeadHours, getSplitMinDistanceKm } from '@src/app/utils/rideSchedule.utils';
import { buildStoredFareBreakdown } from '@src/app/utils/fareBreakdownResponse.utils';
import { toRiderPriceView } from '@src/app/utils/riderPriceResponse.utils';
import { generateTransactionId } from '@src/app/utils/generateTransctionId';
import { mockQuery } from '@tests/helpers/mongoose';
import { freezeTime } from '@tests/helpers/time';

const OUT = 'C:/Users/emonh/AppData/Local/Temp/claude/ca7f8959540eb0a0/8af7b3a6-0e61-406c-953e-cbf71fb05cb9/scratchpad/scratch_fare_out_3.json';
const out: Record<string, unknown> = {};
const tryIt = (label: string, fn: () => unknown) => {
  try {
    const r = fn();
    out[label] = r instanceof Date ? r.toISOString() : r;
  } catch (e: any) {
    out[label] = `THROWS ${e?.constructor?.name}: ${e?.message} (code=${e?.code})`;
  }
};

describe('scratch', () => {
  it('tz env', () => {
    out['baseline TZ'] = process.env.TZ;
    out['baseline getRideTimeZone'] = getRideTimeZone();
    vi.stubEnv('RIDE_TIME_ZONE', undefined as any);
    out['after RIDE undefined: env.RIDE_TIME_ZONE'] = String(process.env.RIDE_TIME_ZONE);
    out['getRideTimeZone (RIDE unset, TIME_ZONE set)'] = getRideTimeZone();
    vi.stubEnv('TIME_ZONE', undefined as any);
    out['getRideTimeZone (both unset)'] = getRideTimeZone();
    vi.stubEnv('RIDE_TIME_ZONE', '');
    vi.stubEnv('TIME_ZONE', 'Asia/Dhaka');
    out['RIDE empty, TIME_ZONE dhaka'] = getRideTimeZone();
    out['TZ after'] = process.env.TZ;
    vi.stubEnv('RIDE_TIME_ZONE', "'Dhaka'");
    out['quoted Dhaka'] = getRideTimeZone();
    vi.stubEnv('RIDE_TIME_ZONE', 'Cyprus');
    out['Cyprus alias'] = getRideTimeZone();
    vi.stubEnv('RIDE_TIME_ZONE', 'Mars/Phobos');
    out['invalid'] = getRideTimeZone();
    vi.stubEnv('RIDE_TIME_ZONE', 'Europe/London');
    out['London'] = getRideTimeZone();
    out['TZ after London'] = process.env.TZ;
    vi.stubEnv('RIDE_TIME_ZONE', 'Europe/Nicosia');
    getRideTimeZone();
    out['local date check Nicosia'] = new Date('2026-01-15T22:30:00Z').getDate();
    out['local tz offset Nicosia winter'] = new Date('2026-01-15T10:00:00Z').getTimezoneOffset();
    out['local tz offset Nicosia summer'] = new Date('2026-07-15T10:00:00Z').getTimezoneOffset();
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  });

  it('stored breakdown', async () => {
    const o2: Record<string, unknown> = {};
    const settingsDocs = [
      { key: 'platformVat', value: 9 },
      { key: 'platformCommissionPercent', value: 10 },
      { key: 'baseFare', value: 20 },
      { key: 'fivePassengerExtraChargePercentage', value: 20 },
      { key: 'sixPassengerExtraChargePercentage', value: 40 },
      { key: 'splitRideMatchedSurchargePercent', value: 30 },
      { key: 'fareRoundingBracket', value: 5 },
    ];
    const run = async (label: string, passenger: any, ride: any, docs: any[] = settingsDocs, booking?: any) => {
      vi.mocked(Setting.find).mockReturnValue(mockQuery(docs) as any);
      o2[label] = await buildStoredFareBreakdown(passenger, booking, ride);
    };
    const base = { initialCharge: 3.8, perKmCharge: 0.95, totalKmCharge: 47.5, waitingCharge: 0, totalFare: 60, estimatedFare: 60 };
    await run('private day 50km', base, { type: 'private' });
    await run('private missing settings', base, { type: 'private' }, []);
    await run('private stored total 70 vs recomputed 60', { ...base, totalFare: 70 }, { type: 'private' });
    await run('split matched 2 riders surcharge 9', { ...base, totalFare: 40, estimatedFare: 40, surchargeAmount: 9, surchargePercent: 30 }, { type: 'split', currentSurchargePercent: 30 });
    await run('split alone', { ...base }, { type: 'split' });
    await run('ride not object, passenger.rideId populated', { ...base, rideId: { type: 'split' } }, undefined);
    await run('ride unpopulated id', { ...base, rideId: 'abc123' }, undefined);
    await run('no passenger at all', undefined, { type: 'private' });
    await run('six seater', { initialCharge: 3.8, perKmCharge: 0.95, totalKmCharge: 47.5, sixPassengerCharge: 20.52, totalFare: 80 }, { type: 'private' });
    fs.writeFileSync(OUT.replace('_3', '_4'), JSON.stringify(o2, null, 2));

    const o3: Record<string, unknown> = {};
    tryIt('rider view basic', () => toRiderPriceView({ estimatedFare: 60, vatAmount: 4.95, vatPercentage: 9 }));
    tryIt('rider view empty', () => toRiderPriceView({}));
    tryIt('rider view vat 0', () => toRiderPriceView({ estimatedFare: 60, vatAmount: 0, vatPercentage: 0 }));
    tryIt('rider view NaN fare', () => toRiderPriceView({ estimatedFare: NaN }));
    tryIt('rider view totalFare only', () => toRiderPriceView({ totalFare: 33.333 }));
    tryIt('rider view estimatedFare 0 totalFare 50', () => toRiderPriceView({ estimatedFare: 0, totalFare: 50 }));
    tryIt('rider view vatIncluded false', () => toRiderPriceView({ vatIncluded: false }));
    tryIt('rider view string', () => toRiderPriceView({ estimatedFare: '12.345' as any }));
    tryIt('rider view null', () => toRiderPriceView({ estimatedFare: null as any, totalFare: 7 }));
    o3['x'] = out;
    freezeTime('2026-12-31T22:30:00Z');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    tryIt('txid year boundary', () => generateTransactionId());
    fs.writeFileSync(OUT.replace('_3', '_5'), JSON.stringify(out, null, 2));

    // lead settings
    const leadOut: Record<string, unknown> = {};
    for (const [label, val] of [['0', 0], ['-1', -1], ["'abc'", 'abc'], ["'5'", '5'], ['24', 24], ['3', 3], ['0.5', 0.5], ['null', null], ["''", '']] as const) {
      vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ key: 'x', value: val }) as any);
      vi.mocked(Setting.findOneAndUpdate).mockClear();
      const split = await getMinBookingLeadHours('split');
      const writes1 = vi.mocked(Setting.findOneAndUpdate).mock.calls.length;
      const priv = await getMinBookingLeadHours('private');
      const dist = await getSplitMinDistanceKm();
      const writes2 = vi.mocked(Setting.findOneAndUpdate).mock.calls.length;
      leadOut[`value=${label}`] = { split, writes1, priv, dist, writesTotal: writes2 };
    }
    fs.writeFileSync(OUT.replace('_3', '_6'), JSON.stringify(leadOut, null, 2));
  });
});
