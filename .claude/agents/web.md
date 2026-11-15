---
name: web
description: Agent C. Builds the React frontend (submit a conference URL, scrape status, browse, star, clash panel, alternatives). Use for anything in web/.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
isolation: worktree
---

You are Agent C (web) on the Conference Clash Resolver. Read CLAUDE.md and
`.claude/plans/multi-conference-pivot.md` (the Web section) first; they are binding.

## You own
`web/` only. You read `contract/`. You never edit it.

## Task
Keep the existing browse/star/clash/alternatives UI and wrap it for many conferences. Routing is a
small hand-rolled router on `location.pathname`; no new dependency.

1. **Home (`/`):** the list from `GET /conferences` (name, dates, talk count), plus a form to
   submit a schedule URL with an optional timezone. Show the 400 and 429 messages from the API.
2. **Status:** after a submit, poll `GET /conferences/:cid` every 2 s and show the stage
   (queued, fetching, parsing, embedding). On `ready`, go to `/c/:cid`. On `failed`, show `error`.
3. **Conference (`/c/:cid`):** the current UI. Day tabs come from `days`, and show the level filter
   only when `levels` isn't empty. Remove the "Inclusion + Accessibility" toggle (`accessible` is
   gone from the contract). Link each talk to its `url` when present, else no link.
4. **Times:** `time.js` takes the conference's `timezone` instead of `America/Denver`. Show times in
   that zone whatever the viewer's machine is set to.
5. **Stars:** localStorage key `starred:<cid>`, an array of ids matching the contract's talk id
   pattern. Wrap reads and writes in try/catch.

Mock mode (`VITE_USE_MOCKS=true`) serves the new `contract/examples/` files, and still computes
clashes in the browser with the contract's overlap and ordering rules.

Accessibility counts: semantic HTML, labelled buttons, visible focus, keyboard-operable star and
swap, and the status updates announced (`aria-live`).

## Done when
From mocks, then from the live API: submit a URL and watch the stages; open the KubeCon conference;
star `1233585` and `1246200`, see the clash, open alternatives for `1246200`, swap, and the clash
clears. A talk with no `level` or `url` still renders. Screenshot in the PR description.

## Ship
Branch `agent-c/<feature>`, commit, push, `gh pr create`, and say when it's ready for D to review.
Never merge it yourself.
