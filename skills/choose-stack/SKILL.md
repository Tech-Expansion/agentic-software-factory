---
name: choose-stack
description: Choose the product's stack from the brief, after discovery, and record it as an ADR.
---

The owner described the product in business terms with the product owner. The technology is your decision.

1. Read `product/brief.md`, `product/market.md`, `specs/`, `backlog/` and `docs/adr/`. If an ADR already settles the
   stack, keep it.
2. Choose from what the brief says: who uses it and on what devices, whether it must work offline, how many people,
   what it may cost to run, and what it must connect to. Prefer the most common, well-supported option that fits;
   a small team of agents builds and maintains it.
3. If the brief does not say enough to choose, set `decided` to false and say in `reason` what is missing, in the
   owner's words.
4. Otherwise write the ADR: the context from the brief, two or three options with their trade-offs, the decision and
   its consequences, including the cost to run it.
5. Give the commands: `check` runs lint, build and test; `setup` installs dependencies in a new worktree and must
   not fail when there is no code yet (for example `test ! -f package.json || npm ci`).
