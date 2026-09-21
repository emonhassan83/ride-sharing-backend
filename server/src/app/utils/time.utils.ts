// utils/time.utils.ts
import { isDayFareDateTime } from './fareMath.utils';

export function getFareType(departureDateTime: Date): 'day' | 'night' {
  // Day = 06:00:00–20:29:59, Night = 20:30:00–05:59:59
  return isDayFareDateTime(departureDateTime) ? 'day' : 'night';
}
