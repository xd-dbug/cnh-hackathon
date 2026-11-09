# CLAUDE.md

## Project
Conference Clash Resolver, built at the WeMakeDevs Cloud Native Hackathon (Nov 9, 2026).
Users star KubeCon NA 2026 talks. The app finds talks whose times overlap and suggests
similar talks at times that don't clash with the rest of their picks.

## Stack
- Elasticsearch on the local kind cluster (ECK operator), reachable at `http://localhost:9200`.
  The only datastore. Abstracts are in a `semantic_text` field.
- Node + Express API, JavaScript (ES modules).
- React (Vite) frontend, JavaScript.
- No Postgres, no auth. Starred talks live in the browser's localStorage.
- OpenTelemetry: the API sends OTLP to the Collector running in kind (`http://localhost:4318`),
  and the Collector forwards to Dash0. The API never holds the Dash0 token.
- The whole local stack (kind, Elasticsearch, Collector) is rebuilt by `infra/up.sh`.

## Layout and ownership
| Folder | Owner | Notes |
|---|---|---|
| `contract/` | D (human) | `mapping.json`, `examples/*.json`. Read-only for agents. |
| `schedule.html` | D (human) | Saved page snapshot at the repo root. Read-only for everyone. |
| `infra/` | D (human) | kind config, ECK Elasticsearch, Collector values, `up.sh`. Read-only for agents. |
| `ingest/` | Agent A | Extractor and loader. Reads `../schedule.html`. |
| `api/` | Agent B | Express server. |
| `web/` | Agent C | React app. |
| `api/instrumentation.js` | Agent T | The only file in `api/` that the telemetry agent may create or edit, plus the start script line that loads it and OpenTelemetry dependencies in `api/package.json`. |

## Rules
1. `contract/` is the source of truth. Do not edit it. If it looks wrong, stop and say so.
2. Only edit files in the folder you own. Exception: any agent may change the root `package-lock.json` when it adds a dependency (npm workspaces keep one lockfile at the root).
3. One feature = one branch = one PR. Branches: `agent-a/…`, `agent-b/…`, `agent-c/…`, `agent-t/…`. Never push to `main`. Keep PRs small.
4. Address Gitar's review comments before asking for a merge.
5. JavaScript, not TypeScript. Add JSDoc to any function that sends or receives contract data.
6. No new dependency without a one-line reason in the PR description.
7. No secrets in code. Each checkout has a `.env` that is a symlink to D's env file outside the repo.
   Never create, edit or commit `.env`. If it's missing, stop and ask D. Variables:
   `ES_URL`, `ES_USERNAME`, `ES_PASSWORD`, `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Data facts
Source: https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/

Snapshot: `schedule.html` at the repo root (saved with the browser's "Save page as").

**Do not parse the session HTML.** The page embeds the full dataset as JSON (Sessionize format):
```
<script type="application/json" class="sched-data"> … </script>
```
Extract that script's text, `JSON.parse` it, and use `data.all`:
```
data.all.sessions[]    id, title, description (HTML), startsAt, endsAt,
                       speakers (speaker ids), categoryItems (category item ids), roomId
data.all.speakers[]    id, firstName, lastName, …
data.all.rooms[]       id, name                     e.g. "Salt Palace | Level 1 | Hall DE"
data.all.categories[]  title, items[] { id, name }
```
Map each session to a Talk:
```
id        = session.id                         (string; official page is ?id=<id>)
title     = session.title
abstract  = session.description → strip HTML, decode entities (&#039; etc.)
start/end = startsAt / endsAt + "-07:00"
room      = rooms[roomId].name
venue     = room name before the first " | "  ("Salt Palace" / "Hyatt Regency")
speakers  = speakers[] ids → "firstName lastName"
track     = categoryItems in category "All Sessions"
level     = categoryItems in category "Audience Level"   (Beginner | Any Level | Advanced)
tags      = names from "SubTopic" and "CNCF Projects"
```
Any lookup can come back empty. Skip that field, don't crash.

Times: the source has no timezone. All times are Mountain Time, so append `-07:00` on load
and keep it in every query.

Two talks clash when `a.start < b.end && b.start < a.end`.

Keep only sessions whose track is in this allowlist, and that run 90 minutes or less:
AI Inference + Agentic, Application Development + Delivery, Cloud Native Experience,
Cloud Native Novice, Connectivity, Data Processing + Storage, Emerging + Advanced,
Observability, Operations + Performance, Platform Engineering, Security, Maintainer Track,
⚡ Lightning Talks, 📚 Tutorials, Inclusion + Accessibility, Project Lightning Talks.

Expected result: **328 talks** (Mon 51, Tue 100, Wed 101, Thu 76). If the count is far off, the
extraction is wrong.

## Commands
- `infra/up.sh`: rebuild the local stack (D runs this, not agents)
- `npm run ingest`: extract talks from `schedule.html` and load them into Elasticsearch
- `npm run dev:api`: API on port 3001
- `npm run dev:web`: web app on port 5173

## Done means
- **A (ingest):** prints the talk count (expect 328) and one sample document from the index.
- **B (api):** a curl of each endpoint returns the same shape as `contract/examples/`.
- **C (web):** renders from `contract/examples/`, then from the live API.
- **T (telemetry):** an API request shows up as a trace in Dash0.

## AI use
Code is written by Claude Code subagents, directed and reviewed by D. The README discloses this.
