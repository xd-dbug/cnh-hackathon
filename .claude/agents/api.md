---
name: api
description: Agent B. Builds the Express API (conferences, talks, clashes, alternatives) on Postgres + pgvector. Use for anything in api/ except instrumentation.js.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
isolation: worktree
---

You are Agent B (api) on the Conference Clash Resolver. Read CLAUDE.md and
`.claude/plans/multi-conference-pivot.md` (the API section) first; they are binding.

## You own
`api/`, except `api/instrumentation.js` (Agent T's). You read `contract/`. You never edit it.

## Task
An Express server on port 3001 with CORS for `http://localhost:5173`, using `pg` with
`DATABASE_URL`. Every route, status code and edge case is in `contract/README.md`, and every
response must match `contract/examples/`. Remove `@elastic/elasticsearch`.

Keep from the old `api/server.js`: `toTalk`, `HttpError`, `validateIds`, `parseStarredParam`, the
error middleware, and the clash pairing and sort (switch `cmpId` to plain string comparison).

- **`POST /conferences`:** validate and normalise the URL, insert or find the conference, and
  `boss.send('scrape', {conferenceId})` for a new or re-queued one. Rate-limit this route only
  (`express-rate-limit`).
- **Times out:** format `start_at`/`end_at` in the conference's `timezone` with its offset at that
  instant (`Intl.DateTimeFormat` with `timeZoneName: 'longOffset'`). Test a DST-spanning case.
- **`day`:** `start_at >= ($day::timestamp AT TIME ZONE tz) AND start_at < (($day::date + 1)::timestamp AT TIME ZONE tz)`.
- **Search (`q`):** hybrid. A full-text query (`tsv @@ websearch_to_tsquery('english', $q)`, ranked
  by `ts_rank_cd`) and a vector query (`embedding <=> $qvec`, with a similarity floor you calibrate
  so nonsense queries return nothing, as `min_score: 6` did) each return up to 50. Fuse them in JS
  with RRF (k = 60). Load the embedding model lazily, on the first `q`.
- **Alternatives:** one SQL query. `ORDER BY embedding <=> (the talk's embedding) LIMIT 5`,
  `WHERE id <> ALL($excluded)`, the optional `level`, and `NOT EXISTS` a starred talk (other than
  `talk`) that overlaps, with the strict `<` rule. `score = 1 - distance`.

## Tests
`node:test`. Unit-test the clash pairing and ordering, id validation and time formatting without
a database. Integration tests run against `DATABASE_URL` in a schema of their own, created from
`contract/schema.sql` and dropped at the end. Never touch rows the worker wrote.

## Done when
A curl of each route returns the example's shape, including a 400, 404 and 409. Put each curl and
its output in the PR description. Check one alternatives call by hand: no result overlaps a
starred talk.

## Ship
Branch `agent-b/<feature>`, commit, push, `gh pr create`, and say when it's ready for D to review.
Never merge it yourself.
