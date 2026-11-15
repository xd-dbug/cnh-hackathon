// A small robots.txt parser (RFC 9309 subset: User-agent groups, Allow, Disallow, * and $ in paths).

/**
 * @param {string} text robots.txt body
 * @param {string} agentToken product token to match, e.g. "ConferenceClashResolver"
 * @returns {{allow: boolean, pattern: string}[]} rules from the most specific matching group
 */
export function rulesFor(text, agentToken) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const token = agentToken.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * The longest matching rule wins; Allow wins a tie; no matching rule means allowed.
 * @param {{allow: boolean, pattern: string}[]} rules
 * @param {string} pathAndQuery e.g. "/schedule/?day=1"
 * @returns {boolean}
 */
export function isAllowed(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!patternToRegExp(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}
