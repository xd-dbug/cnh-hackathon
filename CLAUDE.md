# CLAUDE.md

## Project
Conference Clash Resolver. Started at the WeMakeDevs Cloud Native Hackathon (Nov 9, 2026) for
KubeCon NA 2026 only; now being rebuilt for any conference. A user submits a conference schedule URL,
a background job scrapes it, and the user then stars talks, sees which overlap, and gets similar
talks at times that don't clash with the rest of their picks.

**Status:** mid-migration. The plan and PR order are in `.claude/plans/multi-conference-pivot.md`.
Until those PRs land, `ingest/` and the Elasticsearch code in `api/` are the old build; don't extend them.

## Stack
- Postgres 18 + pgvector, run by CloudNativePG in kind. The only datastore: conferences, talks,
  embeddings and the job queue. Schema: `contract/schema.sql`.
- Job queue: pg-boss (on the same Postgres, so no Redis).
- Embeddings: `@huggingface/transformers` with `Xenova/bge-small-en-v1.5` (384 dimensions, CPU,
  no API key). The worker embeds title + abstract; the API embeds only search queries.
- Node + Express API, Node worker, JavaScript (ES modules).
- React (Vite) frontend, JavaScript.
- No auth. Starred talks live in the browser's localStorage, keyed per conference.
- OpenTelemetry: the API and the worker send OTLP to the Collector in kind (`http://localhost:4318`),
  which forwards to Grafana LGTM (Tempo, Loki, Prometheus) in the cluster. Grafana is on `localhost:3000`.
- Everything is self-hosted and free. No paid or trial services.
- The local stack (kind, Postgres, the Collector, LGTM) is rebuilt by `infra/up.sh`.

## Layout and ownership
| Folder | Owner | Notes |
|---|---|---|
| `contract/` | D (human) | `schema.sql`, `examples/*.json`, `README.md`. Read-only for agents. |
| `schedule.html` | D (human) | Saved KubeCon page. The Sessionize test fixture. Read-only for everyone. |
| `infra/` | D (human) | kind config, Postgres, Collector, LGTM, `up.sh`. Read-only for agents. |
| `worker/` | Agent S (scraper) | Safe fetch, platform adapters, embeddings, queue consumer, `npm run scrape`. Replaces `ingest/`. |
| `api/` | Agent B | Express server. |
| `web/` | Agent C | React app. |
| `api/instrumentation.js`, `worker/instrumentation.js` | Agent T | Plus the start-script line that loads each, and the OpenTelemetry dependencies in each `package.json`. |

## Rules
1. `contract/` is the source of truth. Do not edit it. If it looks wrong, stop and say so.
2. Only edit files in the folder you own. Exception: any agent may change the root `package-lock.json`
   when it adds a dependency (npm workspaces keep one lockfile at the root).
3. One feature = one branch = one PR. Branches: `agent-s/…`, `agent-b/…`, `agent-c/…`, `agent-t/…`.
   Never push to `main`. Keep PRs small. `npm test` must pass before you ask for review.
4. JavaScript, not TypeScript. Add JSDoc to any function that sends or receives contract data.
5. No new dependency without a one-line reason in the PR description.
6. No secrets in code. Each checkout has a `.env` that is a symlink to D's env file outside the repo.
   Never create, edit or commit `.env`. If it's missing, stop and ask D. Variables:
   `DATABASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`.
7. Tests use `node:test` (built in). Adapters are tested against saved fixtures in
   `worker/test/fixtures/`, never live sites.

## Data facts
The contract (`contract/README.md`) defines the Talk and Conference shapes and every API rule.
These are the facts it doesn't cover.

**Times:** stored as `timestamptz`, with an IANA `timezone` per conference. Take the timezone from
the source data when it has one, else the `timezone` the user gave, else fail the job with a message
asking for one. Never hard-code an offset.

Two talks clash when `a.start < b.end && b.start < a.end`.

**Normalising any source:** skip service sessions (breaks, lunch, registration, "TBA") and anything
over 4 hours. Strip HTML from abstracts, decode entities, keep paragraph breaks as `\n\n`. Any field
can be missing: skip it, don't crash.

**Sessionize (and the KubeCon fixture).** Do not parse the session HTML. The page embeds the full
dataset as JSON:
```
<script type="application/json" class="sched-data"> … </script>
```
`JSON.parse` that script's text and use `data.all`:
```
data.all.sessions[]    id, title, description (HTML), startsAt, endsAt,
                       speakers (speaker ids), categoryItems (category item ids), roomId
data.all.speakers[]    id, firstName, lastName, …
data.all.rooms[]       id, name                     e.g. "Salt Palace | Level 1 | Hall DE"
data.all.categories[]  title, items[] { id, name }
```
Sessionize times have no offset: they are local to the event. Map `room` from `rooms[roomId].name`,
`venue` as the room name before the first `" | "`, `speakers` as `"firstName lastName"`. `track`,
`level` and `tags` come from categories, whose titles vary by event; for KubeCon they are
"All Sessions", "Audience Level", and "SubTopic" + "CNCF Projects".

**KubeCon fixture test:** `schedule.html` is KubeCon NA 2026 in Salt Lake City (`America/Denver`).
With this track allowlist and a 90-minute limit it must give **328 talks** (Mon 51, Tue 100,
Wed 101, Thu 76). The allowlist belongs to the test, not the app:
AI Inference + Agentic, Application Development + Delivery, Cloud Native Experience,
Cloud Native Novice, Connectivity, Data Processing + Storage, Emerging + Advanced,
Observability, Operations + Performance, Platform Engineering, Security, Maintainer Track,
⚡ Lightning Talks, 📚 Tutorials, Inclusion + Accessibility, Project Lightning Talks.

**Other platforms** (Pretalx, frab/Pentabarf XML, Sched, iCal, JSON-LD): see the worker section of
the plan. Each adapter gets its own notes here as it lands.

## Commands
- `infra/up.sh`: rebuild the local stack (D runs this, not agents). Prints `DATABASE_URL`.
- `npm test`: unit tests in every workspace.
- `npm run scrape -- <url|file>`: run the scrape pipeline once, without the queue.
- `npm run dev:worker`: the queue worker.
- `npm run dev:api`: API on port 3001.
- `npm run dev:web`: web app on port 5173.

## Done means
- **S (scraper):** the adapter's fixture test passes; `npm run scrape` on the fixture loads the
  talks and prints the count and one sample row.
- **B (api):** a curl of each route returns the same shape as `contract/examples/`.
- **C (web):** renders from `contract/examples/`, then from the live API.
- **T (telemetry):** an API request and a scrape job each show up as one trace in Grafana.

## AI use
Code is written by Claude Code subagents, directed and reviewed by D. The README discloses this.
