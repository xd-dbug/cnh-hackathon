# Pivot: Conference Clash Resolver for any conference, with no paid services

## Context
The hackathon build works only for KubeCon NA 2026, from a saved `schedule.html`. It depends on three
trial services: Elastic Cloud Serverless (datastore plus ELSER semantic search), Dash0 (observability)
and Gitar (PR review). The trials are ending, and the idea should outgrow one conference.

**Goal:** a user submits a conference schedule URL, a background job scrapes it, and the user then
browses, stars talks, sees clashes and gets non-clashing alternatives, as today. Everything runs
self-hosted in kind for $0, with no paid or trial services.

**Decisions made:** adapters for known platforms, with no LLM. Local/self-hosted first.
Postgres + pgvector with locally computed embeddings. Grafana LGTM in the cluster instead of Dash0.
Gitar removed.

## Target architecture
```
Browser (React) ──> API (Express) ──> Postgres + pgvector (CloudNativePG, kind ns `data`)
                         │  enqueue (pg-boss)        ▲
                         ▼                           │ upsert talks + embeddings
                    Worker (Node) ── fetch URL ──> detect platform ──> adapter ──> normalise ──> embed
API + Worker ──OTLP──> OTel Collector (ns `otel`) ──> otel-lgtm: Tempo/Loki/Prometheus/Grafana (ns `observability`)
```
- **One datastore:** Postgres holds conferences, talks, embeddings and the job queue. pg-boss runs the
  queue on Postgres, so there's no Redis.
- **Embeddings:** `@huggingface/transformers` with `Xenova/bge-small-en-v1.5`: 384 dimensions,
  512-token window, runs on CPU, no API key. The model downloads from Hugging Face once and is cached.
  The worker embeds abstracts. The API embeds only search queries, loading the model lazily.
  Alternatives use stored vectors.
- **Times:** stored as `timestamptz`, plus an IANA `timezone` per conference. The API returns ISO
  times with that conference's offset at that moment, so DST is handled. This replaces the hard-coded
  `-07:00` and `America/Denver`.

## Data model (new `contract/schema.sql`, replacing `contract/mapping.json`)
- `conferences`: `id` (short slug/uuid), `source_url` (normalised, unique), `platform`, `name`,
  `timezone`, `status` (`queued|fetching|parsing|embedding|ready|failed`), `error`, `talk_count`,
  `created_at`, `scraped_at`.
- `talks`: `conference_id` FK, `id` (source id as text), `title`, `abstract`, `start_at`, `end_at`,
  `room`, `venue`, `speakers text[]`, `track`, `level`, `tags text[]`, a generated weighted
  `tsv tsvector` (title A, speakers/tags B, abstract C), `embedding vector(384)`.
  Primary key `(conference_id, id)`. GIN index on `tsv`, HNSW index on `embedding`.
- A re-scrape replaces a conference's talks inside one transaction. This removes the README's
  "search drops during re-ingest" limitation.

## API (contract v2; D writes or approves `contract/` first)
| Route | Purpose |
|---|---|
| `POST /conferences {url}` | Validate the URL, dedupe on the normalised URL, enqueue a job. Returns 202 + conference (or the existing one). Rate-limited. |
| `GET /conferences` | List `ready` conferences (name, dates, talk count). |
| `GET /conferences/:cid` | Status, for polling: stage, error, talk count, timezone, days, levels present. |
| `GET /conferences/:cid/talks?q=&day=` | Browse a day (sorted by start, then id; size cap 1000) or hybrid search (cap 50). |
| `POST /conferences/:cid/clashes` | Same rule and ordering as today: `a.start < b.end && b.start < a.end`. |
| `GET /conferences/:cid/alternatives?talk=&starred=&level=` | Top 5 by cosine similarity that clash with no other starred talk. |

- **Hybrid search:** a full-text query (`websearch_to_tsquery`, ranked with `ts_rank_cd`) and a vector
  query (`embedding <=> $q`, with a similarity floor recalibrated the way `min_score: 6` was), fused in
  JS with RRF (k=60). This ports the logic in `api/server.js` (`GET /talks`).
- **Alternatives SQL:** `ORDER BY embedding <=> (talk's embedding)`, `WHERE id <> ALL(excluded)`, and
  `NOT EXISTS` an overlapping starred talk, using the same strict `<` rule. `score = 1 - distance`.
- **Contract rule changes:** talk ids become opaque strings `^[A-Za-z0-9_-]{1,64}$` (Pretalx uses
  codes, not digits). Times carry the conference's own offset. `accessible` is dropped because it was
  KubeCon-specific. `level` stays optional. All other rules stay: missing fields, 400 vs 404, ignoring
  unknown starred ids, `score` used only for ranking.
- **Reuse:** `toTalk`, `validateIds`, `parseStarredParam`, `HttpError` and the clash pairing and sort
  in `api/server.js` carry over almost unchanged. Only the data access moves from ES to `pg`.

## Worker (new `worker/` workspace, replaces `ingest/`)
1. **Safe fetch.** http/https only. Resolve DNS and reject private, loopback, link-local and metadata
   addresses (`ipaddr.js`), and check again on every redirect (5 at most). 15 s timeout, 10 MB cap.
   Honour `robots.txt`. Send a generic User-Agent.
2. **Detect, then adapt.** Each adapter is `{ name, detect(url, html), extract(ctx) → RawSession[] }`:
   - **sessionize:** the embedded `script.sched-data` JSON (move `readSchedule`, `cleanAbstract` and
     `buildTalks` from `ingest/index.js`), plus Sessionize embed/API URLs (`sessionize.com/api/v2/<id>/view/All`).
   - **pretalx:** `/<event>/schedule/` → `/<event>/schedule/export/schedule.json`.
   - **frab/Pentabarf XML:** `schedule.xml` (FOSDEM, CCC events).
   - **sched:** `<event>.sched.com` → its iCal export.
   - **ical:** any `.ics` URL, or a `<link type="text/calendar">` on the page.
   - **json-ld:** schema.org `Event` / `subEvent` as the last fallback.
   - **None match:** status `failed`, with a clear "unsupported site" message and the list of
     supported platforms.
3. **Normalise.** Convert to the Talk shape. Skip service sessions (breaks, lunch, registration) and
   anything over 4 h. Detect the timezone from the source data, falling back to a `timezone` the user
   gives in the submit form. The KubeCon track allowlist becomes a property of the KubeCon fixture
   test, not app logic.
4. **Embed** in batches, **upsert** in one transaction, set status `ready`. Update the status at each
   stage so the UI can show progress.
- **Dev CLI:** `npm run scrape -- <url|file>` runs the pipeline once without the queue.
  `schedule.html` stays at the root and becomes the Sessionize fixture.

## Web (`web/`)
- **Home page:** the list of ready conferences, plus a URL submit form (with an optional timezone).
  After submitting, a status view polls `GET /conferences/:cid` every 2 s and shows the stage, or the
  error.
- **Conference page** (`/c/:cid`, a small hand-rolled router on `location.pathname`, no new
  dependency): the current UI, with the day tabs built from `days` and the level filter shown only
  when the conference has levels.
- **Changes:** `time.js` takes the conference `timezone` instead of `America/Denver`. `storage.js`
  keys stars by `starred:<cid>` and accepts the new id format. `api.js` paths gain `/conferences/:cid`.
  Mock mode reads the new contract examples.

## Infra (`infra/`, D's folder; changes drafted for D's review)
- **Postgres:** install the CloudNativePG operator and add a `Cluster` with pgvector (`CREATE EXTENSION
  vector` at bootstrap; verify that the CNPG image ships pgvector, otherwise use a pgvector-enabled
  image). NodePort → `localhost:5433` (5432 is often a host Postgres). `up.sh` prints `DATABASE_URL`, built from the generated
  `<cluster>-app` Secret, for D to put in the env file.
- **Observability:** run `grafana/otel-lgtm` as a Deployment in `observability`, with Grafana NodePort
  → `localhost:3000`. The Collector values swap the `otlp_grpc/dash0` exporter for the LGTM service,
  and the Dash0 Secret logic in `up.sh` is deleted.
- **`kind.yaml`:** drop the 9200 mapping, add 5433 and 3000.
- **Delete:** `infra/elasticsearch.yaml` and `infra/dash0/`.
- **`infra/k8s/`:** add a worker Deployment. The API and worker get `DATABASE_URL` from the CNPG
  Secret instead of `clash-es`. Bake the embedding model into the worker and api images at build time.
  The Dash0 comments go.

## Telemetry
- `api/instrumentation.js` stays as it is, since it already exports plain OTLP. The worker gets the
  same setup (`worker/instrumentation.js`), with the `pg` and pg-boss work traced, one trace per job.
- **Custom worker metrics:** `scrape.jobs` (by status and platform), `scrape.duration`,
  `scrape.talks`, `embed.duration`.
- **Dashboard as code:** a Grafana JSON dashboard, provisioned by ConfigMap. Port the panels in
  `infra/dash0/site-health.mjs` to Prometheus metric names: `http_server_request_duration_seconds_*`,
  with the ES panels replaced by Postgres query latency. Add a scrape-jobs row.

## Repo and workflow
- **Remove Gitar:** delete `.gitar/` and CLAUDE.md rule 4.
- **Add free CI:** `.github/workflows/ci.yml` runs `node --test` across the workspaces.
- **Update CLAUDE.md:** stack, env vars (`DATABASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`), data facts
  (generic Talk mapping plus per-adapter notes), commands and "done means".
- **Update the agents:** `ingest` becomes `scraper` (owns `worker/`). Rewrite `api` for Postgres.
  `telemetry` also covers `worker/instrumentation.js`. `web` gets the new flow.
- **Tests:** `node:test`, built in, so no new test dependency. Unit tests cover the clash logic,
  ports of the overlap/ordering rules, and each adapter against a saved fixture in
  `worker/test/fixtures/` (the KubeCon `schedule.html` plus one Pretalx JSON, one frab XML and one
  ICS). Integration tests run against the kind Postgres.
- **New dependencies, with reasons:** `pg` (Postgres client), `pg-boss` (job queue on Postgres, so no
  Redis), `@huggingface/transformers` (local embeddings, no API key), `fast-xml-parser` (frab XML),
  `ical.js` (iCal), `cheerio` (find JSON-LD/links in HTML), `ipaddr.js` (SSRF range checks),
  `express-rate-limit` (submit endpoint). Removed: `@elastic/elasticsearch`.

## PR order (each its own branch, small)
1. `contract/` v2 (`schema.sql`, examples for every route, README rules), plus CLAUDE.md, agent
   files and `.gitar/` removal. D reviews this first.
2. Infra: CNPG + pgvector, otel-lgtm, Collector exporter swap, kind ports, Dash0 and ES removal.
3. Worker: the safe fetch, queue, Sessionize adapter (KubeCon fixture), embeddings, the
   `npm run scrape` CLI.
4. API on Postgres, with the new routes.
5. Web: submit/status flow, conference routing, per-conference timezone.
6. Worker adapters: Pretalx, frab, Sched/iCal, JSON-LD.
7. Telemetry: worker instrumentation, custom metrics, Grafana dashboard.
8. k8s: worker Deployment, images with the baked-in model, `deploy.sh`.
9. README rewrite and CI workflow.

## Verification
- **Unit tests:** `npm test` passes the adapter fixtures and the clash/ordering rules. The KubeCon
  fixture with the old allowlist and 90-minute filter gives **325 talks (48/100/101/76)**; 328 at the hackathon included two mis-tracked coffee breaks and a lunch.
- **End to end:** `infra/up.sh`, then `npm run dev:api` and `dev:worker`. Then:
  - `curl -XPOST :3001/conferences -d '{"url":"<pretalx event>"}'` and poll until `ready`.
  - `curl` every route and check that the shapes match `contract/examples/`.
  - Repeat with the KubeCon `schedule.html` and one FOSDEM `schedule.xml`.
- **UI:** in the browser, submit a URL, watch the stages, star two overlapping talks, see the clash,
  open alternatives, swap, and see the clash clear. Times show in the conference's timezone.
- **SSRF:** submitting `http://127.0.0.1`, `http://169.254.169.254` and a redirect to a private IP is
  rejected.
- **Grafana** (`localhost:3000`): one `/alternatives` request is one trace down to the `pg` spans, a
  scrape job is one trace, and the dashboard panels have data.
- **Clean-up:** `grep -ri 'elastic\|dash0\|gitar'` finds nothing outside the README history note.
