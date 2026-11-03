# 0002. The factory and each product live in separate repositories

Status: accepted
Date: 2026-11-03
Deciders: project owner

## Context

[0001](0001-run-inside-the-users-own-agent-cli.md) makes the factory a kit that runs inside the official agent CLIs,
driven by a local runner. Two kinds of content now need a home:

- **The factory itself:** role definitions, the skill library, workflows, default policies, the runner and its
  runtime adapters. It is the same for every product, and learning from one product should improve it for the next.
- **A product:** its brief, specs, decisions, backlog, code and documentation, plus the factory settings chosen for it
  (stage, budget, kill criteria, opt-ins). It belongs to the product and must make sense without the factory.

Work is spec-driven: brief → feature specs with numbered acceptance criteria → backlog items that reference them →
code and tests that reference the criteria. When a requirement changes, that chain shows what is affected.

Tokens are a design metric, so an agent step should receive only the role, skills and artifacts it needs.

## Options considered

1. **Copy the factory into every product repository** (agents, skills, policies next to the code). Each repository
   works on its own, but every copy drifts, a better skill reaches old products only by hand, and the product
   repository is full of factory files.
2. **One repository for the factory and all products.** One place to learn from, but products cannot be shared, open
   sourced or handed over one by one, and unrelated histories mix.
3. **The factory in this repository, each product in its own, joined by a small settings folder.** The product holds
   only its own artifacts and one `.factory/` folder; the runner brings roles and skills from the factory into each
   step. A product depends on a factory version, which has to be recorded.

## Decision

We take option 3.

This repository:

```text
AGENTS.md          how agents work on this repository
docs/adr/          decisions about the factory
agents/            role definitions: planner, builder, verifier, operator
skills/            skill library; each skill has SKILL.md, examples/ and evals/
workflows/         the flows by stage (explore, validate, grow) and by kind (feature, bug fix, release)
policies/          default policy: what needs approval, what agents may do alone
templates/         the skeleton of a new product repository
runner/            the local runner and its runtime adapters (Claude Code, Codex)
schemas/           JSON Schema for project.yaml, policy.yaml and run-log events
tests/
```

A product repository:

```text
AGENTS.md          how to run, test and build this product: for any agent or person
.factory/
  project.yaml     factory version, stage, hypothesis, success metric, kill criteria, budget, opt-ins
  policy.yaml      product overrides: can tighten the default policy, never loosen it
  memory/          project memory: context, conventions, lessons
  runs/            append-only run log; ignored by git
product/           brief.md (problem, users, MVP, out of scope), roadmap.md
specs/             feature specs with acceptance criteria ids; api/ and data/ when needed
backlog/           one file per item, each referencing a spec and its criteria
docs/adr/          decisions about the product
docs/              setup, user guide, deployment, operations
...                source code, laid out as the chosen stack expects
```

Rules that come with the layout:

- Roles and skills stay in the factory and are not copied into products. The runtime adapter gives each step its role
  and only the skills the step needs, in the form its CLI expects.
- `project.yaml` and `policy.yaml` are data. The runner validates them against `schemas/` and enforces the policy
  itself, before it starts a step. An agent cannot change either file without an approval.
- Opt-ins live in `project.yaml` and default to what needs no third party: backlog and docs as Markdown in the
  repository, notifications on the desktop. Jira, Confluence, Telegram and the like come later, as adapters.
- `.factory/` is the only thing a product needs to be run by the factory. Delete it and the product is an ordinary
  repository.
- Settings that span products (the list of products, default opt-ins) live in the user's factory home, outside every
  repository. The runner ADR decides where.

## Consequences

- An improved skill or role reaches every product on the next run, without touching product repositories.
- A change to the factory can break a product mid-flight. `project.yaml` pins the factory version, and upgrades are a
  deliberate step.
- A product can be open sourced, handed over or moved out of the factory on its own.
- Backlog in Markdown keeps the first version local-first and offline. Two-way sync with an external tracker is real
  work and will need its own decision.
- The run log stays on the user's machine. Learning across products reads the logs of all registered products
  locally, and nothing leaves the machine by default.
- The runner has to know how each CLI loads roles and skills for one call. That is the adapter's job, and it is
  tested against each supported CLI version.
