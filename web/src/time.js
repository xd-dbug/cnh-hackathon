const TZ = 'America/Denver';

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/**
 * Format a talk's start/end as Mountain Time, whatever the viewer's timezone.
 * @param {string} start ISO timestamp with offset
 * @param {string} end ISO timestamp with offset
 * @returns {string} e.g. "Tue, Nov 10, 11:30 AM - 12:00 PM MT"
 */
export function formatRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  return `${dayFmt.format(s)}, ${timeFmt.format(s)} - ${timeFmt.format(e)} MT`;
}
