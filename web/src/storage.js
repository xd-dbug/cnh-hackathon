const KEY = 'starred';

/** @returns {string[]} starred talk ids */
export function loadStarred() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^\d+$/.test(x)) : [];
  } catch {
    return [];
  }
}

/** @param {string[]} ids */
export function saveStarred(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable; keep in-memory state */
  }
}
