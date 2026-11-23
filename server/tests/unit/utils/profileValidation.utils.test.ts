/**
 * Client QA round 3, issues 24, 27, 28, 29: "." accepted as a name / address,
 * 1900 accepted as a birth year, and a 1900 car accepted. The rules live in
 * profileValidation.utils and back the user and vehicle Zod schemas.
 */
import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  isAdultDriverDob,
  isAllowedVehicleYear,
  isValidAddress,
  isValidDateOfBirth,
  isValidPersonName,
  parseDateOfBirth,
} from '@src/app/utils/profileValidation.utils';
import { UserValidation } from '@src/app/modules/user/user.validation';
import { VehicleValidation } from '@src/app/modules/vehicle/vehicle.validation';

const NOW = new Date('2026-11-23T12:00:00Z');

describe('isValidPersonName (issue 24)', () => {
  it.each(['.', ' . ', '..', 'A', '12', '!!', ''])('rejects %j', (v) => {
    expect(isValidPersonName(v)).toBe(false);
  });
  it.each(['Aakib', 'Al', 'Jean-Luc', "O'Brien", 'Γιώργος', 'אבי', 'Юлія', 'Mary Ann 2'])('accepts %j', (v) => {
    expect(isValidPersonName(v)).toBe(true);
  });
});

describe('isValidAddress (issue 29)', () => {
  it.each(['.', '...', ' - ', 'a', '1.'])('rejects %j', (v) => {
    expect(isValidAddress(v)).toBe(false);
  });
  it.each(['139, Bhopal Division, Biaora, 465674', '12 Makariou Ave', 'Λευκωσία', 'Flat 4B'])('accepts %j', (v) => {
    expect(isValidAddress(v)).toBe(true);
  });
});

describe('date of birth (issue 27)', () => {
  it('parses the formats the app may send', () => {
    expect(parseDateOfBirth('1995-05-20')?.toISOString()).toBe('1995-05-20T00:00:00.000Z');
    expect(parseDateOfBirth('1995-05-20T00:00:00.000Z')?.toISOString()).toBe('1995-05-20T00:00:00.000Z');
    expect(parseDateOfBirth('20-05-1995')?.toISOString()).toBe('1995-05-20T00:00:00.000Z');
    expect(parseDateOfBirth('20/05/1995')?.toISOString()).toBe('1995-05-20T00:00:00.000Z');
    expect(parseDateOfBirth('20.05.1995')?.toISOString()).toBe('1995-05-20T00:00:00.000Z');
  });

  it('rejects impossible or unknown dates', () => {
    expect(parseDateOfBirth('31-02-2000')).toBeNull();
    expect(parseDateOfBirth('2000-13-01')).toBeNull();
    expect(parseDateOfBirth('yesterday')).toBeNull();
    expect(parseDateOfBirth('')).toBeNull();
  });

  it('QA case: 20-11-1900 and 20-11-1904 are refused (over 100 years)', () => {
    expect(isValidDateOfBirth('20-11-1900', NOW)).toBe(false);
    expect(isValidDateOfBirth('20-11-1904', NOW)).toBe(false);
  });

  it('refuses a future date and accepts a normal one', () => {
    expect(isValidDateOfBirth('2027-01-01', NOW)).toBe(false);
    expect(isValidDateOfBirth('1995-05-20', NOW)).toBe(true);
    expect(isValidDateOfBirth('24-11-1926', NOW)).toBe(true); // 99 years old
  });

  it('computes age around the birthday', () => {
    expect(ageInYears(new Date('2008-11-23T00:00:00Z'), NOW)).toBe(18);
    expect(ageInYears(new Date('2008-11-24T00:00:00Z'), NOW)).toBe(17);
  });

  it('drivers must be 18+', () => {
    expect(isAdultDriverDob('2008-11-23', NOW)).toBe(true);
    expect(isAdultDriverDob('2008-11-24', NOW)).toBe(false);
    expect(isAdultDriverDob('2015-01-01', NOW)).toBe(false);
  });
});

describe('vehicle year (issue 28)', () => {
  it('QA case: 1900 is refused; the oldest allowed car is 30 years old', () => {
    expect(isAllowedVehicleYear(1900, NOW)).toBe(false);
    expect(isAllowedVehicleYear(1995, NOW)).toBe(false);
    expect(isAllowedVehicleYear(1996, NOW)).toBe(true);
    expect(isAllowedVehicleYear(2027, NOW)).toBe(true);
    expect(isAllowedVehicleYear(2028, NOW)).toBe(false);
    expect(isAllowedVehicleYear(2020.5, NOW)).toBe(false);
  });
});

describe('Zod schemas use the rules', () => {
  const update = (body: Record<string, unknown>) =>
    UserValidation.updateUserValidationSchema.safeParse({ body }).success;

  it('profile update', () => {
    expect(update({ name: '.' })).toBe(false);
    expect(update({ address: '.' })).toBe(false);
    expect(update({ dateOfBirth: '20-11-1900' })).toBe(false);
    expect(update({ name: 'Aakib Khan', address: '12 Makariou Ave', dateOfBirth: '1995-05-20' })).toBe(true);
    expect(update({ language: 'el' })).toBe(true); // all profile fields stay optional
  });

  it('sign-up name', () => {
    const signUp = (name: string) =>
      UserValidation.createUserValidationSchema.safeParse({
        body: { name, email: 'a@example.com', phone: '+35799111222' },
      }).success;
    expect(signUp('.')).toBe(false);
    expect(signUp('Aakib')).toBe(true);
  });

  it('location update address', () => {
    const loc = (address: string) =>
      UserValidation.updateLocationValidationSchema.safeParse({ body: { longitude: 1, latitude: 2, address } }).success;
    expect(loc('.')).toBe(false);
    expect(loc('Nicosia')).toBe(true);
  });

  it('vehicle create / update year', () => {
    const year = new Date().getFullYear();
    const car = (y: number) =>
      VehicleValidation.createVehicleZodSchema.safeParse({ body: { name: 'Toyota', number: 'ABC 123', year: y, seats: 4 } }).success;
    expect(car(year - 31)).toBe(false);
    expect(car(year - 5)).toBe(true);
    expect(VehicleValidation.updateVehicleZodSchema.safeParse({ body: { year: 1900 } }).success).toBe(false);
  });
});
