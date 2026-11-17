const key = (cid) => `starred:${cid}`;
const TALK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {string} cid the conference id, e.g. 7fk2m9qx4agit commit -am "web: store stars per conference".
 * @returns {string[]} starred talk ids */
export function loadStarred(cid) {
  try {
    const v = JSON.parse(localStorage.getItem(key(cid)) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && TALK_ID.test(x)) : [];
  } catch {
    return [];
  }
}

/** 
 * @param {string} cid
 * @param {string[]} ids */
export function saveStarred(cid, ids) {
  try {
    localStorage.setItem(key(cid), JSON.stringify(ids));
  } catch {
    /* storage unavailable; keep in-memory state */
  }
}
