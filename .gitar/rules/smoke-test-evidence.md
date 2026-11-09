---
title: "Smoke test evidence"
description: "Ask for the smoke test output when an agent PR's description doesn't include it"
when: "A pull request is opened from a branch starting with agent- and its description has no command output or screenshot"
actions: "Post a pull request comment asking for the smoke test evidence listed in this rule for that branch"
---

# Smoke test evidence

Every agent PR proves itself in its description. Ask for what's missing:

- `agent-a/…` (ingest): output showing the talk count (expected 328, with per-day counts) and a
  semantic search for "backing up persistent volumes" returning the Velero talk in the top 3.
- `agent-b/…` (api): a curl command and its output for each changed endpoint.
- `agent-c/…` (web): a screenshot of the demo path (clash shown, alternatives listed, swap clears it).
- `agent-t/…` (telemetry): a screenshot of an `/alternatives` trace in Dash0.
