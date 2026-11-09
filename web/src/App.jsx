import { useEffect, useState } from 'react';
import { fetchTalks, fetchClashes, fetchAlternatives } from './api.js';
import { loadStarred, saveStarred } from './storage.js';
import { formatRange } from './time.js';

const DAYS = [
  { label: 'Mon', date: '2026-11-09' },
  { label: 'Tue', date: '2026-11-10' },
  { label: 'Wed', date: '2026-11-11' },
  { label: 'Thu', date: '2026-11-12' },
];
const LEVELS = ['Beginner', 'Any Level', 'Advanced'];
const OFFICIAL = 'https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/?id=';

/** Run an async loader whenever deps change, ignoring stale results. */
function useAsync(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error: error.message, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function Meta({ talk }) {
  return (
    <dl className="meta">
      <div>
        <dt>When</dt>
        <dd>{formatRange(talk.start, talk.end)}</dd>
      </div>
      {talk.room && (
        <div>
          <dt>Room</dt>
          <dd>{talk.room}</dd>
        </div>
      )}
      {talk.speakers?.length > 0 && (
        <div>
          <dt>Speakers</dt>
          <dd>{talk.speakers.join(', ')}</dd>
        </div>
      )}
      {talk.track && (
        <div>
          <dt>Track</dt>
          <dd>{talk.track}</dd>
        </div>
      )}
      {talk.level && (
        <div>
          <dt>Level</dt>
          <dd>{talk.level}</dd>
        </div>
      )}
    </dl>
  );
}

function TalkTitle({ talk }) {
  return (
    <a href={OFFICIAL + talk.id} target="_blank" rel="noreferrer">
      {talk.title}
      <span className="visually-hidden"> (opens official page in a new tab)</span>
    </a>
  );
}

function TalkCard({ talk, starred, onToggle }) {
  return (
    <article className={`card${starred ? ' is-starred' : ''}`}>
      <div className="card-head">
        <h3>
          <TalkTitle talk={talk} />
        </h3>
        <button
          type="button"
          className="star"
          aria-pressed={starred}
          aria-label={`${starred ? 'Unstar' : 'Star'} ${talk.title}`}
          onClick={() => onToggle(talk.id)}
        >
          <span aria-hidden="true">{starred ? '★' : '☆'}</span>
        </button>
      </div>
      <Meta talk={talk} />
    </article>
  );
}

function ClashSide({ talk, onFind, active }) {
  return (
    <div className="clash-side">
      <h4>
        <TalkTitle talk={talk} />
      </h4>
      <Meta talk={talk} />
      <button
        type="button"
        aria-pressed={active}
        aria-label={`Find alternatives for ${talk.title}`}
        onClick={() => onFind(talk)}
      >
        Find alternatives
      </button>
    </div>
  );
}

function snippet(text = '', n = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n).trimEnd()}…` : flat;
}

export default function App() {
  const [day, setDay] = useState(DAYS[1].date);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [starred, setStarred] = useState(loadStarred);
  const [level, setLevel] = useState('');
  const [accessible, setAccessible] = useState(false);
  const [altFor, setAltFor] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => saveStarred(starred), [starred]);

  const talks = useAsync(() => fetchTalks({ day, q: query }), [day, query]);
  const clashes = useAsync(() => fetchClashes(starred), [starred]);
  const alts = useAsync(
    () =>
      altFor
        ? fetchAlternatives({ talk: altFor.id, starred, level, accessible })
        : Promise.resolve([]),
    [altFor, starred, level, accessible],
  );

  const toggle = (id) =>
    setStarred((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const swap = (alt) => {
    setStarred((s) => [...s.filter((x) => x !== altFor.id && x !== alt.id), alt.id]);
    setAltFor(null);
  };

  const clashList = clashes.data || [];

  return (
    <>
      <header>
        <h1>Conference Clash Resolver</h1>
        <p>KubeCon NA 2026. All times Mountain Time. Starred: {starred.length}</p>
      </header>
      <main>
        <section aria-labelledby="clash-h" className="panel" aria-live="polite">
          <h2 id="clash-h">Clashes ({clashList.length})</h2>
          {clashes.error && <p role="alert">Could not check clashes: {clashes.error}</p>}
          {!clashes.error && !clashes.loading && clashList.length === 0 && (
            <p>{starred.length ? 'No clashes in your starred talks.' : 'Star talks to check for clashes.'}</p>
          )}
          <ul className="plain">
            {clashList.map(({ a, b }) => (
              <li key={`${a.id}-${b.id}`} className="clash">
                <ClashSide talk={a} active={altFor?.id === a.id} onFind={setAltFor} />
                <span className="vs" aria-hidden="true">
                  vs
                </span>
                <ClashSide talk={b} active={altFor?.id === b.id} onFind={setAltFor} />
              </li>
            ))}
          </ul>
        </section>

        {altFor && (
          <section aria-labelledby="alt-h" className="panel">
            <h2 id="alt-h">Alternatives to “{altFor.title}”</h2>
            <div className="filters">
              <label>
                Level{' '}
                <select value={level} onChange={(e) => setLevel(e.target.value)}>
                  <option value="">Any</option>
                  {LEVELS.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={accessible}
                  onChange={(e) => setAccessible(e.target.checked)}
                />{' '}
                Inclusion + Accessibility
              </label>
              <button type="button" onClick={() => setAltFor(null)}>
                Close
              </button>
            </div>
            {alts.error && <p role="alert">Could not load alternatives: {alts.error}</p>}
            {alts.loading && <p>Loading…</p>}
            {!alts.loading && !alts.error && alts.data?.length === 0 && (
              <p>No alternatives found that avoid your other starred talks.</p>
            )}
            <ul className="plain">
              {(alts.data || []).map((t) => (
                <li key={t.id} className="card">
                  <h3>
                    <TalkTitle talk={t} />
                  </h3>
                  <Meta talk={t} />
                  {t.abstract && <p className="snippet">{snippet(t.abstract)}</p>}
                  <button
                    type="button"
                    aria-label={`Swap ${altFor.title} for ${t.title}`}
                    onClick={() => swap(t)}
                  >
                    Swap
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="browse-h" className="panel">
          <h2 id="browse-h">Browse talks</h2>
          <div className="filters">
            <div role="group" aria-label="Day">
              {DAYS.map((d) => (
                <button
                  key={d.date}
                  type="button"
                  className="day"
                  aria-pressed={day === d.date}
                  onClick={() => setDay(d.date)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <label>
              Search{' '}
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
          {talks.error && <p role="alert">Could not load talks: {talks.error}</p>}
          {talks.loading && <p>Loading…</p>}
          {!talks.loading && !talks.error && talks.data?.length === 0 && <p>No talks found.</p>}
          <ul className="plain grid">
            {(talks.data || []).map((t) => (
              <li key={t.id}>
                <TalkCard talk={t} starred={starred.includes(t.id)} onToggle={toggle} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
