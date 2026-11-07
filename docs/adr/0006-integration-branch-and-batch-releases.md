# 0006. An integration branch, batch releases, and plans for high-risk items

Status: accepted
Date: 2026-11-07
Deciders: project owner

## Context

With every item waiting for `asf approve`, the owner is in the loop for each change, and an unattended team stops
whenever they are away. Approving everything in a batch, though, would let keys, signing or money code through
without the line-by-line look it needs. And for that kind of work a wrong approach costs more than any review of the
diff can save.

## Decision

- With `integration_branch` in `project.yaml`, items branch from it, and an item that passes its checks and review
  merges into it on its own, in a worktree of its own (`.factory/worktrees/_integration`). It stays `merged` in the run
  state until the owner runs `asf release`, which merges the integration branch into the base branch in their
  checkout. Without `integration_branch`, nothing changes: each item waits for `asf approve`.
- An item still waits for the owner on its own when its change touches `approval_paths` or `sensitive_paths`, or it is
  `risk: high`.
- A `risk: high` item is planned before anything is written: a read-only tech lead returns approach, files, tests and
  risks, and the build starts only after the owner approves the plan. The builder gets the approved plan; a rejected
  plan is written again with the reason.
- A merge that does not apply cleanly is aborted and the item blocked with the reason, never resolved by an agent.

## Consequences

- The owner reads releases, plans and sensitive changes instead of every diff. What merges on its own is what the
  checks, the locked acceptance tests and the verifier all passed.
- The integration branch can hold work the owner has not seen yet; nothing on it reaches the base branch without
  `asf release`.
- Items that depend on each other build in order on the integration branch, so the second sees the first.
