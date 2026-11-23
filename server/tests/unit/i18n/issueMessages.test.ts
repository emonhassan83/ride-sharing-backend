/**
 * User-facing texts added or changed for the QA issues, in all five languages,
 * plus issue 68 (pickup notification wording).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { translateText } from '@src/app/i18n/i18n';

const LANGS = ['en', 'el', 'he', 'ru', 'uk'] as const;
const src = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../src/app/${p}`, import.meta.url)), 'utf8');

const SPLIT_SEARCH =
  'No matching split ride found yet. Complete payment and we will keep looking for a ride partner until 1 hour before pickup. If no partner is found by then, your ride continues as a Solo ride.';
const OFFLINE = 'You are offline. Go online to accept rides.';

describe('ISSUE 15: split search wording says WHEN the Solo fallback happens', () => {
  it('the handler sends the new wording and the old "1h Solo fallback" text is gone', () => {
    const handler = src('socket/handlers/ride/splitRideRequest.handler.ts');
    expect(handler).toContain(SPLIT_SEARCH);
    expect(handler).not.toContain('1h Solo fallback');
  });

  it.each(LANGS.filter((l) => l !== 'en'))('is translated to %s', (lang) => {
    const translated = translateText(SPLIT_SEARCH, lang);
    expect(translated).not.toBe(SPLIT_SEARCH);
    expect(translated).toContain('Solo');
  });
});

describe('ISSUE 58: offline-accept message', () => {
  it.each(LANGS.filter((l) => l !== 'en'))('is translated to %s', (lang) => {
    expect(translateText(OFFLINE, lang)).not.toBe(OFFLINE);
  });
});

describe('ISSUE 68: "Driver has picked you up. Safe journey." is not sent by the server', () => {
  it('the registered pickup handler is pickUpRideClean.handler', () => {
    expect(src('socket/socket.event.ts')).toMatch(
      /import \{ pickUpRideHandler \} from '\.\/handlers\/ride\/pickUpRideClean\.handler'/,
    );
  });

  it('the registered pickup handler never contains the old wording', () => {
    const handler = src('socket/handlers/ride/pickUpRideClean.handler.ts');
    expect(handler).not.toMatch(/Safe journey/i);
    expect(handler).not.toMatch(/Driver has picked you up/);
  });

  it('even if the old English text reaches the translator, it is rewritten to the corrected sentence', () => {
    expect(translateText('Driver has picked you up. Safe journey!', 'en')).toBe(
      'Your driver has picked you up. Have a safe journey!',
    );
  });
});
