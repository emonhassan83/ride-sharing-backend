// utils/time.utils.ts
import { isDayFareDateTime } from './fareMath.utils';

export function getFareType(departureDateTime: Date): 'day' | 'night' {
  // Day = 05:00–22:29, Night = 22:30–04:59 (Komistra PDF)
  return isDayFareDateTime(departureDateTime) ? 'day' : 'night';
}
