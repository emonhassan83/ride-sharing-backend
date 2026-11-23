// Client QA round 3, issues 24, 27, 28, 29: the API accepted "." as a name or an
// address, a date of birth in 1900, and a 1900 car. These helpers back the Zod
// schemas so the rules live in one place and are unit-tested.

export const NAME_MIN_LENGTH = 2;
export const ADDRESS_MIN_LENGTH = 3;
export const MAX_AGE_YEARS = 100;
export const MIN_DRIVER_AGE_YEARS = 18;
// Product decision pending: oldest vehicle a driver may register.
export const MAX_VEHICLE_AGE_YEARS = 30;

export const INVALID_NAME_MESSAGE = 'Please enter a valid name (at least 2 letters).';
export const INVALID_ADDRESS_MESSAGE = 'Please enter a valid address.';
export const INVALID_DOB_MESSAGE = 'Please enter a valid date of birth.';
export const DRIVER_TOO_YOUNG_MESSAGE = 'Drivers must be at least 18 years old.';
export const VEHICLE_TOO_OLD_MESSAGE = 'Vehicle is too old. Please add a newer vehicle.';

/** At least two letters (any script), not just dots, digits or symbols. */
export const isValidPersonName = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < NAME_MIN_LENGTH) return false;
  const letters = trimmed.match(/\p{L}/gu) || [];
  return letters.length >= NAME_MIN_LENGTH;
};

/** At least 3 characters and some letters or digits ("." or "..." is rejected). */
export const isValidAddress = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < ADDRESS_MIN_LENGTH) return false;
  const alnum = trimmed.match(/[\p{L}\p{N}]/gu) || [];
  return alnum.length >= 2;
};

const buildUtcDate = (y: number, m: number, d: number): Date | null => {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject roll-overs such as 31-02-2000.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
};

/** Accepts YYYY-MM-DD (optionally ISO with time), DD-MM-YYYY, DD/MM/YYYY and DD.MM.YYYY. */
export const parseDateOfBirth = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const v = value.trim();

  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return buildUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return buildUtcDate(Number(m[3]), Number(m[2]), Number(m[1]));

  return null;
};

export const ageInYears = (dob: Date, now: Date = new Date()): number => {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
};

/** A real, past date, no more than 100 years ago. */
export const isValidDateOfBirth = (value: unknown, now: Date = new Date()): boolean => {
  const dob = parseDateOfBirth(value);
  if (!dob || dob.getTime() > now.getTime()) return false;
  return ageInYears(dob, now) <= MAX_AGE_YEARS;
};

export const isAdultDriverDob = (value: unknown, now: Date = new Date()): boolean => {
  const dob = parseDateOfBirth(value);
  return !!dob && ageInYears(dob, now) >= MIN_DRIVER_AGE_YEARS;
};

/** Evaluated per request, so the allowed range moves with the calendar. */
export const isAllowedVehicleYear = (year: number, now: Date = new Date()): boolean => {
  const current = now.getFullYear();
  return Number.isInteger(year) && year >= current - MAX_VEHICLE_AGE_YEARS && year <= current + 1;
};
