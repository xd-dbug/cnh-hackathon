import { decode } from 'he';

/**
 * Strip HTML, decode entities, keep paragraph breaks as \n\n.
 * @param {string} [html]
 * @returns {string}
 */
export function cleanAbstract(html = '') {
  if (typeof html !== 'string') return '';
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|ul|ol|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return decode(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A readable conference name from a page's <title>: "Schedule | KubeCon + CloudNativeCon North America"
 * becomes "KubeCon + CloudNativeCon North America".
 * @param {string} html
 * @returns {string|undefined}
 */
export function nameFromTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? '');
  if (!m) return undefined;
  const parts = decode(m[1]).split(/\s+[|–—-]\s+/).map((p) => p.trim()).filter(Boolean);
  const specific = parts.filter((p) => !/^(schedule|program|programme|agenda|sessions?|timetable)$/i.test(p));
  return (specific[0] ?? parts[0])?.slice(0, 200);
}
