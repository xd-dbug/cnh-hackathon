---
title: "Contract guard"
description: "Warn when anyone other than the contract PR changes the shared contract"
when: "A pull request changes any file under contract/ and its branch name starts with agent-"
actions: "Post a pull request comment warning that agents must not edit the contract, and list the changed contract files"
---

# Contract guard

`contract/` is owned by D. Agents read it but never change it. If an agent thinks the contract is
wrong, it should stop and say so in the PR, not edit it.

Comment with:
- the contract files this PR changed
- a reminder that every other agent is building against the current contract, so changing it here
  breaks them silently
- a request to revert the contract changes and raise the problem with D instead
