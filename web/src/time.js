
const cache = new Map();
function formatters(timeZone) {
  let f = cache.get(timeZone);
  if (!f) {
    f = {
      time: new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }),
      day: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', }),
      zone: new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short', })
    };
    cache.set(timeZone, f);
  }
  return f;
}
/**
 * Format a talk's start and end in the conference's timezone, whatever the viewer's timezone.
 * @param {string} start ISO timestamp with offset
 * @param {string} end ISO timestamp with offset
 * @param {string} timeZone IANA name of the conference, e.g. "America/Denver"
 * 
 * @returns {string} e.g. "Tue, Nov 10, 11:30 AM - 12:00 PM MST"
 */
export function formatRange(start, end, timeZone) {
  const f = formatters(timeZone)
  const s = new Date(start);
  const e = new Date(end);
  const zone = f.zone.formatToParts(e).find((p) => p.type === 'timeZoneName').value;
  return `${f.day.format(s)}, ${f.time.format(s)} - ${f.time.format(e)} ${zone}`;
}
