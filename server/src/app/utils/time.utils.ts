// utils/time.utils.ts
export function getFareType(departureDateTime: Date): 'day' | 'night' {
  const hours = departureDateTime.getHours();
  const minutes = departureDateTime.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  // Day: 06:00 AM (360 minutes) to 08:30 PM (20:30 = 1230 minutes)
  // Night: 08:30 PM to 06:00 AM next day
  if (totalMinutes >= 360 && totalMinutes < 1230) {
    return 'day';
  } else {
    return 'night';
  }
}
