# 0008. Checks inside the builder's session

Status: accepted
Date: 2026-11-07
Deciders: project owner

## Context

When the checks fail after a build, the runner starts a new attempt: a new CLI session that has to read the item,
the code and the failure again. Each attempt costs the fixed overhead of a session (about 30k input tokens) plus the
re-reading, and the builder has lost what it knew when it stopped.

## Decision

- A build step on Claude Code gets a Stop hook. When the builder wants to finish, the hook runs the product's checks
  the way the runner does: sandboxed, with secrets removed from the environment. If they fail, the builder is sent
  back with the output, in the same session.
- It is sent back at most `check_rounds_in_session` times (policy, default 3, 0 turns it off). After that it may
  finish, and the runner's check step decides as before.
- The hook's settings and its count live in `.factory/runs/hooks/`, outside the worktree. The run log records the
  rounds of each build call.
- The tests step and read-only steps get no hook. Codex has no Stop hook; there the runner's attempts remain the
  only loop.

## Consequences

- A failing check is usually fixed within the attempt that caused it, which saves a session per failure.
- The hook adds no trust: whatever it does, the runner's own checks, the locked tests and the verifier still run after
  the builder finishes. A builder that tampers with the hook only loses the chance to fix things early.
- A long check suite runs inside the builder's time budget; the hook's timeout is 30 minutes.
- Checked with Claude Code 2.1 in `-p` mode: the hook from `--settings` fires on each stop and its decision is
  followed.
