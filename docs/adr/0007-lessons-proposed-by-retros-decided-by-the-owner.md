# 0007. Lessons proposed by retros, decided by the owner, never loosening the policy

Status: accepted
Date: 2026-11-07
Deciders: project owner

## Context

A team that repeats a mistake costs the owner a rejection or a blocked item each time. Writing every lesson into a
longer prompt does not scale: prompts grow, cost tokens on every call, and are followed loosely. A team that changes
its own rules unattended is also a way for one bad ticket to weaken every later item.

## Decision

- After an item that needed more than one attempt or was rejected, a read-only `retro` role reads what went wrong and
  proposes at most three lessons, or none. Each is a `check`, a `doc`, or a `skill` or `workflow` change, scoped to the
  product or to the factory. A paused item or a runtime error gets no retro, and a failed retro never changes the
  item's outcome.
- Lessons are only proposals (`.factory/lessons.json`). They join the owner's decision queue, and the owner accepts or
  rejects each one with `asf lesson <id> accept|reject` or `/lesson <id> accept|reject` on the digest ticket.
- Accepting a lesson does one of three things, none of which can touch the policy:
  - a product check becomes a ready backlog item, built through the normal workflow, where the builder cannot touch
    protected paths;
  - a product doc becomes one line under "Lessons" in `.factory/memory/context.md`, which the agents read;
  - a factory lesson becomes a proposal file under `~/.agentic-software-factory/proposals/`, adopted into this
    repository only with `asf eval` numbers from before and after.
- A mistake that repeats an accepted doc lesson comes back as a proposed check, because the doc did not stop it. One
  that repeats a rejected lesson comes back to the owner with the count.
- `asf eval --without <step>` and `--workflow <file>` measure what a step is worth. A run with either is labelled with
  it, so it is not mistaken for a baseline.

## Consequences

- Learning costs one read-only call per troubled item and nothing per clean one.
- The owner sees each lesson once and decides in seconds; nothing the team learns takes effect without them.
- Factory lessons from all products land in one place, to be measured and turned into pull requests to this
  repository; they do not change the installed factory on their own.
