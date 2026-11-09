# Review instructions

This repo is built in one day by several AI coding agents working in parallel, each owning one folder.
The biggest risks are agents drifting from the shared contract and subtle time-overlap bugs. Review
for those first; style comes last.

Project conventions, data facts and folder ownership:

@../../CLAUDE.md

## Flag as blocking
1. **Contract drift.** Any API response or frontend data access whose field names, types or nesting
   differ from `contract/examples/*.json`, or any index field that differs from `contract/mapping.json`.
2. **Timezone loss.** All talk times are Mountain Time (`-07:00`). Flag:
   - a talk time that is stored, parsed, compared or queried without the `-07:00` offset;
   - `new Date(str)` where `str` has no offset (`new Date()` with no argument, for the current time, is fine);
   - a talk time shown in the UI without `timeZone: 'America/Denver'` (for example a bare
     `toLocaleTimeString()` or `getHours()`), which shows the wrong time to anyone outside Mountain Time.
3. **Wrong overlap logic.** Two talks clash only when `a.start < b.end && b.start < a.end`. Flag `<=`
   (back-to-back talks don't clash), checks of only one side, or comparing dates as strings without offsets.
4. **Alternatives that clash.** In `/alternatives`, results must exclude the talk itself, every starred
   talk, and any talk that overlaps any *other* starred talk. Flag a missing exclusion.
5. **Ownership violations.** A PR from branch `agent-a/…` may only change `ingest/`, `agent-b/…` only
   `api/` (not `api/instrumentation.js`), `agent-c/…` only `web/`, and `agent-t/…` only
   `api/instrumentation.js` plus, in `api/package.json`, the start script line that loads it and
   OpenTelemetry packages in `dependencies`. Any agent may also change the root `package-lock.json`
   when it adds a dependency, because the repo uses npm workspaces. Nobody but D changes
   `contract/` or `schedule.html`.
6. **Secrets.** Any API key, token or URL with credentials outside `.env`.
7. **Truncated starred-talk lookups.** An Elasticsearch query that loads a user's starred talks (or
   any set used for clash detection) without an explicit `size` large enough for every requested id.
   The default is 10 hits, so a user with more than 10 stars silently loses clashes.

## Flag as non-blocking
- Unhandled errors that would crash the server instead of returning 400/404/500.
- Other Elasticsearch calls without a size limit (starred-talk lookups are blocking, see 7).
- `localStorage` access without try/catch.
- Missing JSDoc on functions that send or receive contract data.
- New dependencies without a reason in the PR description.

## Don't flag
- Missing unit tests. Each PR proves itself with a smoke test in its description.
- Performance tweaks for an index of about 328 documents.
- Formatting nits.
