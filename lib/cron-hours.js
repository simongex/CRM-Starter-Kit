/* Vercel cron is UTC and does not follow daylight saving. The jobs are
   scheduled wide enough for both GMT and BST, then this check keeps only
   08:00–19:59 Europe/London. */

export function londonHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour')?.value);
}

export function withinLondonWorkHours(date = new Date()) {
  const hour = londonHour(date);
  return hour >= 8 && hour <= 19;
}
