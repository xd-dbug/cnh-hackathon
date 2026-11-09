Prepare my hackathon repo `cnh-hackathon` for tomorrow. This is **repo setup and environment checks
only. Do not write any application code** (no scraper, no server, no React components): the rules
say building starts at 11:00 tomorrow. Config, folders and placeholders are fine.

I've put these files in the repo root. Move each one into place:
- `CLAUDE.md` → stays at the root
- `ingest.md`, `api.md`, `web.md`, `telemetry.md` → `.claude/agents/`
- `instructions.md` → `.gitar/review/`
- `contract-guard.md`, `smoke-test-evidence.md` → `.gitar/rules/`
- the saved schedule page (the long `…Schedule _ KubeCon + CloudNativeCon North America.html`
  filename) → rename to `schedule.html` at the root

Read CLAUDE.md first. Everything below should match it.

## 1. Repo skeleton
- Empty folders `contract/examples/`, `ingest/`, `api/` and `web/`, each with a one-line README
  saying who owns it (from the CLAUDE.md ownership table). Don't add `package.json` files inside them;
  the agents create those.
- A root `package.json`: private, `"type": "module"`, npm workspaces `["ingest","api","web"]`, and
  scripts `ingest`, `dev:api` and `dev:web` that run each workspace's script of the same name. Node 20+ in `engines`.
- `.gitignore`: node_modules, .env, dist, .DS_Store.
- `.env.example` with `ES_URL`, `ES_API_KEY`, `DASH0_ENDPOINT` and `DASH0_AUTH_TOKEN`, empty values.
- A `README.md` skeleton with headings only: What it does, Demo, How it's built (one line per sponsor
  tool: Elasticsearch, Gitar, Dash0), Run it locally, AI use (a sentence saying it was built with
  Claude Code subagents directed and reviewed by me). Leave the rest for tomorrow.

## 2. Sanity-check the data
Write a throwaway script in a temp folder **outside the repo**. Extract the
`<script type="application/json" class="sched-data">` block from `schedule.html`, apply the track
allowlist and the 90-minute limit from CLAUDE.md, and confirm the result is 328 talks
(Mon 51, Tue 100, Wed 101, Thu 76). Report the numbers, then delete the script. If they don't match, stop and tell me.

## 3. Check the environment
Report each as working / needs my action:
- Node 20+, npm, git, `gh` (logged in), Docker running.
- Elasticsearch from start-local is up: curl the cluster health endpoint using the `.env` credentials.
- **`semantic_text` works.** Create a scratch index `semantic-test` with one `semantic_text` field,
  index two short documents ("backing up Kubernetes volumes", "scaling GPU inference"), and run a
  semantic query for "persistent storage snapshots". The first document should rank first. The first
  run downloads an embedding model and can take minutes, so wait for it. Then delete the index.
- Claude Code loads the four agents: list them. Tell me whether `isolation: worktree` in their
  frontmatter is supported by my Claude Code version. If it isn't, write the exact
  `git worktree add` commands I'd use instead (one folder per agent, next to the repo).

## 4. Git and Gitar
- Commit everything to `main` with the message "Repo setup for Cloud Native Hackathon" and push.
  This setup commit is the only direct push to main; from tomorrow everything goes through PRs.
- Confirm the remote is a public GitHub repo.
- Open one test PR from branch `setup/gitar-check` that only adds a line to the README, so I can
  confirm Gitar reviews it. Give me the PR link and remind me to check that the Gitar GitHub App is
  installed on this repo and that the Pro trial is active (repository rules need it).

## 5. Finish
Give me a checklist: each item above, its status, and anything I still have to do myself tonight.
Ask before installing anything system-wide. If a step fails, stop and explain; don't work around it.
