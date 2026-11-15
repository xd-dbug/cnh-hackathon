// Wall-clock time <-> instants for an IANA timezone, using only Intl.

/** @param {string} tz @returns {boolean} */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at the instant `ms`, in milliseconds (east is positive). */
export function offsetAt(ms, tz) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(whole)) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const DAY = 24 * 3600 * 1000;

/**
 * Convert a wall-clock time ("2026-11-10T09:00:00", no offset) in `tz` to an instant.
 * A time that does not exist (spring forward) moves forward by the gap; a time that happens twice
 * (fall back) takes the first occurrence.
 * @param {string} wall
 * @param {string} tz IANA name
 * @returns {Date}
 */
export function wallClockToDate(wall, tz) {
  const m = WALL.exec(wall);
  if (!m) throw new Error(`Not a wall-clock time: ${wall}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offBefore = offsetAt(asUtc - DAY, tz);
  const offAfter = offsetAt(asUtc + DAY, tz);
  const candidates = [...new Set([offBefore, offAfter])]
    .map((off) => asUtc - off)
    .filter((utc) => offsetAt(utc, tz) === asUtc - utc);
  if (candidates.length) return new Date(Math.min(...candidates));
  // In a gap: no offset round-trips. Use the offset from before the gap, which moves the time forward.
  return new Date(asUtc - offBefore);
}

/**
 * Parse a source timestamp. Strings that carry an offset or Z are exact; others are wall-clock in `tz`.
 * @param {string} value
 * @param {string} [tz]
 * @returns {Date}
 */
export function parseTime(value, tz) {
  if (HAS_ZONE.test(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`Bad time: ${value}`);
    return d;
  }
  if (!tz) throw new Error('No timezone for a time without an offset');
  return wallClockToDate(value, tz);
}

/**
 * Format an instant as ISO 8601 with the zone's UTC offset at that instant (the contract's talk time shape).
 * @param {Date} date
 * @param {string} tz
 * @returns {string} e.g. "2026-11-10T09:00:00-07:00"
 */
export function formatInTz(date, tz) {
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  const off = offsetAt(whole, tz);
  const local = new Date(whole + off).toISOString().slice(0, 19);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60000;
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}
