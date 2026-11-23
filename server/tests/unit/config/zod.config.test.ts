/**
 * Issues 60 / 67: "error messages show strange symbols".
 *
 * Root cause: Zod 4's default messages were sent to users verbatim, e.g.
 *   Invalid option: expected one of "male"|"female"
 *   Invalid string: must match pattern /^\d{4}-\d{2}-\d{2}$/
 * `config/zod.config.ts` installs a global `customError` that produces plain sentences,
 * and the `validation_*` i18n patterns translate them in all five languages.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '@src/app/config/zod.config';
import { humanizeFieldName, zodCustomError } from '@src/app/config/zod.config';
import handleZodError from '@src/app/errors/handleZodError';
import { translateText } from '@src/app/i18n/i18n';

import en from '@src/app/i18n/locales/en/translation.json';
import el from '@src/app/i18n/locales/el/translation.json';
import he from '@src/app/i18n/locales/he/translation.json';
import ru from '@src/app/i18n/locales/ru/translation.json';
import uk from '@src/app/i18n/locales/uk/translation.json';

/** Characters that leaked schema syntax into user-facing messages before the fix. */
const SCHEMA_SYMBOLS = /["|\\^$<>=]|\/\^|\{\d/;

const messagesFor = (schema: z.ZodTypeAny, input: unknown): string[] => {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected validation to fail');
  return result.error.issues.map((issue) => issue.message);
};

describe('ISSUES 60 / 67: validation messages are plain sentences', () => {
  const schema = z.object({
    body: z
      .object({
        gender: z.enum(['male', 'female']),
        departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        email: z.string().email(),
        departureTime: z.string(),
        requestedSeats: z.number().min(1).max(6),
        fullName: z.string().min(2),
        photos: z.array(z.string()).min(1).max(3),
        promoCode: z.string().min(1),
      })
      .strict(),
  });

  const bad = {
    body: {
      gender: 'x',
      departureDate: '23/11/2026',
      email: 'not-an-email',
      requestedSeats: 0,
      fullName: 'A',
      photos: [],
      promoCode: '',
      extra: true,
    },
  };

  it('produces the expected readable message for each kind of error', () => {
    expect(messagesFor(schema, bad)).toEqual(
      expect.arrayContaining([
        'Gender must be one of: male / female.',
        'Departure date has an invalid format.',
        'Please enter a valid email address.',
        'Departure time is required.',
        'Requested seats must be at least 1.',
        'Full name must be at least 2 characters.',
        'Photos must contain at least 1 items.',
        'Promo code is required.',
        'Unexpected field: extra.',
      ]),
    );
  });

  it('no message contains quotes, pipes, regex or comparison symbols', () => {
    for (const message of messagesFor(schema, bad)) {
      expect(message, message).not.toMatch(SCHEMA_SYMBOLS);
    }
  });

  it('max and exclusive bounds read naturally', () => {
    const s = z.object({
      seats: z.number().max(6),
      fare: z.number().gt(0),
      code: z.string().max(4),
      tags: z.array(z.string()).max(2),
    });
    expect(messagesFor(s, { seats: 9, fare: 0, code: 'ABCDEF', tags: ['a', 'b', 'c'] })).toEqual([
      'Seats must be at most 6.',
      'Fare must be greater than 0.',
      'Code must be at most 4 characters.',
      'Tags must contain at most 2 items.',
    ]);
  });

  it('a wrong type that is present reads "has an invalid value" (not "is required")', () => {
    expect(messagesFor(z.object({ seats: z.number() }), { seats: 'two' })).toEqual([
      'Seats has an invalid value.',
    ]);
  });

  it('a message written in the schema always wins over the global default', () => {
    const s = z.object({ name: z.string().min(2, 'Name is too short') });
    expect(messagesFor(s, { name: 'A' })).toEqual(['Name is too short']);
  });

  it('custom refinements keep their own message (hook returns undefined)', () => {
    expect(zodCustomError({ code: 'custom', path: ['x'] })).toBeUndefined();
  });

  it('handleZodError passes the readable messages through to the API response', () => {
    const result = z.object({ gender: z.enum(['male', 'female']) }).safeParse({ gender: 'x' });
    const simplified = handleZodError((result as any).error);
    expect(simplified.errorMessages).toEqual([
      { path: 'gender', message: 'Gender must be one of: male / female.' },
    ]);
  });
});

describe('humanizeFieldName', () => {
  it.each([
    [['body', 'departureTime'], 'Departure time'],
    [['body', 'pickup_location'], 'Pickup location'],
    [['items', 0], 'Items'],
    [['vehicleType'], 'Vehicle type'],
    [[], 'Value'],
  ])('%j -> %s', (path, expected) => {
    expect(humanizeFieldName(path as any)).toBe(expected);
  });
});

describe('ISSUES 60 / 67: validation messages are translated in every language', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['Gender must be one of: male / female.', { el: 'Το πεδίο «Gender» πρέπει να είναι ένα από: male / female.' }],
    ['Departure time is required.', { ru: 'Поле «Departure time» обязательно для заполнения.' }],
    ['Requested seats must be at least 1.', { uk: 'Значення поля «Requested seats» має бути не меншим за 1.' }],
    ['Unexpected field: extra.', { he: 'שדה לא צפוי: extra.' }],
    ['Please enter a valid email address.', { el: 'Εισαγάγετε μια έγκυρη διεύθυνση email.' }],
  ];

  it.each(cases)('"%s"', (english, expected) => {
    for (const [lang, translated] of Object.entries(expected)) {
      expect(translateText(english, lang)).toBe(translated);
    }
    expect(translateText(english, 'en')).toBe(english);
  });

  it('a combined error message (", "-separated) translates each part', () => {
    const combined = 'Gender must be one of: male / female., Departure time is required.';
    expect(translateText(combined, 'ru')).toBe(
      'Поле «Gender» должно быть одним из: male / female., Поле «Departure time» обязательно для заполнения.',
    );
  });

  it('every validation_* pattern exists in all five locale files with the same placeholders', () => {
    const locales: Record<string, any> = { en, el, he, ru, uk };
    const keys = Object.keys((en as any).patterns).filter((k) => k.startsWith('validation_'));
    expect(keys).toHaveLength(13);
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const key of keys) {
      for (const [lang, file] of Object.entries(locales)) {
        expect(file.patterns[key], `${lang}.${key}`).toBeTypeOf('string');
        expect(vars(file.patterns[key]), `${lang}.${key}`).toEqual(vars((en as any).patterns[key]));
      }
    }
  });
});
