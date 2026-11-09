Prepare my hackathon repo `cnh-hackathon` for tomorrow. This is **repo setup and environment checks
only. Do not write any application code** (no extractor, no server, no React components): the rules
say building starts at 11:00 tomorrow. Config, folders and placeholders are fine.

My infra folder is at `<INFRA_DIR>` (outside the repo). It has `kind.yaml`, `elasticsearch.yaml`,
`otel-collector-values.yaml`, `up.sh` and `dash0.env`.

I've put these files in the repo root. Move each one into place:
- `CLAUDE.md` → stays at the root
- `ingest.md`, `api.md`, `web.md`, `telemetry.md` → `.claude/agents/`
- `instructions.md` → `.gitar/review/`
- `contract-guard.md`, `smoke-test-evidence.md` → `.gitar/rules/`
- the saved schedule page (the long `…Schedule _ KubeCon + CloudNativeCon North America.html`
  filename) → rename to `schedule.html` at the root

Read CLAUDE.md first. Everything below should match it.

## 1. Infra into the repo, secrets out
- **Before copying anything,** check `otel-collector-values.yaml` and `elasticsearch.yaml` for any
  literal token, password or Dash0 URL with credentials. If you find one, stop and show me.
- Copy `kind.yaml`, `elasticsearch.yaml`, `otel-collector-values.yaml` and `up.sh` into `infra/`.
  **Do not copy `dash0.env`.** It stays in `<INFRA_DIR>`.
- Make two small changes to `infra/up.sh`, and show me the diff:
  1. Read `dash0.env` from `${CNH_ENV_DIR:-<INFRA_DIR>}/dash0.env` instead of the current directory.
  2. At the end, write `${CNH_ENV_DIR:-<INFRA_DIR>}/.env` with `ES_URL=http://localhost:9200`,
     `ES_USERNAME=elastic`, `ES_PASSWORD=<the password it already reads>` and
     `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. The password changes whenever the cluster
     is recreated, so this keeps the app's `.env` correct automatically.
- Symlink that `.env` into the repo root: `ln -s <INFRA_DIR>/.env .env`.

## 2. Repo skeleton
- Empty folders `contract/examples/`, `ingest/`, `api/` and `web/`, each with a one-line README
  saying who owns it (from the CLAUDE.md ownership table). Don't add `package.json` files inside them;
  the agents create those.
- A root `package.json`: private, `"type": "module"`, npm workspaces `["ingest","api","web"]`, and
  scripts `ingest`, `dev:api` and `dev:web` that run each workspace's script of the same name. Node 20+ in `engines`.
- `.gitignore`: node_modules, `.env`, `*.env`, dist, .DS_Store.
- A `README.md` skeleton with headings only: What it does, Demo, How it's built (one line per sponsor
  tool: Elasticsearch, Gitar, Dash0, plus "runs on kind with ECK and an OpenTelemetry Collector"),
  Run it locally (`infra/up.sh`, then the npm scripts), and AI use (one sentence saying it was built
  with Claude Code subagents directed and reviewed by me). Leave the rest for tomorrow.

## 3. Sanity-check the data
Write a throwaway script in a temp folder **outside the repo**. Extract the
`<script type="application/json" class="sched-data">` block from `schedule.html`, apply the track
allowlist and the 90-minute limit from CLAUDE.md, and confirm the result is 328 talks
(Mon 51, Tue 100, Wed 101, Thu 76). Report the numbers, then delete the script. If they don't match, stop and tell me.

## 4. Check the environment
Run `infra/up.sh`, then report each item as working / needs my action:
- Node 20+, npm, git, `gh` (logged in), Docker, kind and kubectl.
- Elasticsearch is green, and curl to `localhost:9200` works with the `.env` credentials.
- **Elasticsearch can run `semantic_text`. This is the riskiest check, so be thorough:**
  - Report the Elasticsearch version and license (`GET _license`). ECK starts on a basic license,
    and the built-in embedding models need a trial or higher. If it's basic, ask me before running
    `POST _license/start_trial?acknowledge=true`.
  - Check that the node has the `ml` role and report its memory limit from `elasticsearch.yaml`.
    Embedding models need several GB. If the limit looks too low, tell me the change you'd make; don't make it.
  - Create a scratch index `semantic-test` with one `semantic_text` field, index two documents
    ("backing up Kubernetes volumes", "scaling GPU inference"), and query "persistent storage
    snapshots". The first document should rank first. The first run downloads a model and can take
    minutes, so wait for it. Then delete the index.
  - If it can't be made to work tonight, test a `more_like_this` query on the same two documents
    instead and tell me whether it ranks them correctly. That's the fallback that needs no ML.
- The OpenTelemetry Collector is running in the `otel` namespace and `localhost:4318` accepts a
  request. If `telemetrygen` is available, send one test trace and tell me to look for it in Dash0.
- `kubectl radar` starts.
- Claude Code loads the four agents: list them. Tell me whether `isolation: worktree` in their
  frontmatter is supported by my Claude Code version. If it isn't, write the exact
  `git worktree add` commands I'd use instead (one folder per agent, next to the repo), each followed
  by the `ln -s <INFRA_DIR>/.env .env` it needs.

## 5. Git and Gitar
- Commit everything to `main` with the message "Repo setup for Cloud Native Hackathon" and push.
  Check `git status` first: `.env` and `dash0.env` must not be staged. This setup commit is the only
  direct push to main; from tomorrow everything goes through PRs.
- Confirm the remote is a public GitHub repo.
- Open one test PR from branch `setup/gitar-check` that only adds a line to the README, so I can
  confirm Gitar reviews it. Give me the PR link and remind me to check that the Gitar GitHub App is
  installed on this repo and that the Pro trial is active (repository rules need it).

## 6. Finish
Give me a checklist: each item above, its status, and anything I still have to do myself tonight.
Ask before installing anything system-wide. If a step fails, stop and explain; don't work around it.
