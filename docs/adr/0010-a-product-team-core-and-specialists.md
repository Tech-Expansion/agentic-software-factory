# 0010. A product team: a core that builds every item, specialists brought in when needed

Status: accepted; amended by ADR 0012 (the architect became the tech lead, who reviews every change; specialists are opt-in)
Date: 2026-11-14
Deciders: project owner

## Context

The team had seven roles (planner, analyst, tech lead, tester, builder, verifier, retro), named after steps rather
than after the jobs a product team has. Two pairs did one job each: planner and analyst both clarify requirements,
tester and verifier both own quality. There was nobody for security, user experience or delivery, while every item
paid for the same three agent calls whatever its size. The owner found it bloated and hard to operate, and missed
DevOps and SRE.

Real product teams, and agent teams that work (a planner, a generator and an evaluator; reviewers brought in for one
concern), have a small core that every piece of work goes through and specialists who join when the work calls for
them.

## Decision

- **Roles are named after a product team's:**

  | Role | Runs | Was |
  | --- | --- | --- |
  | product owner | every item: `asf discover` with the owner, `asf clarify` unattended | planner, analyst |
  | developer | every item | builder |
  | QA | every item: tests written first, then the verdict, in two separate steps | tester, verifier |
  | architect | the plan of a `risk: high` item | tech lead |
  | security reviewer | when the change touches `sensitive` or `approval` paths, or the item is `risk: high` | new |
  | UX designer | when the change touches `paths.ui` (unset, so off, by default) | new |
  | DevOps engineer | the `infra` workflow (ADR 0011) | new |
  | scrum master | the retrospective after a troubled item | retro |

  SRE is designed in ADR 0011 and built once a product is deployed.
- **A specialist is a workflow step with `when`.** `when: { touches: [...], risk: high }` runs a read-only step only
  if a changed file matches one of its globs or named path lists (`sensitive` and `approval` from the policy, any
  list under `paths:` in `project.yaml`), or the item has that risk. Each reviewer returns a verdict; a blocker from
  any of them sends the item back to the developer. Adding a specialist is a role file and a step, not a new concept.
- **The product owner sizes each item.** `small` (one clear change, nothing to decide) is made ready with
  `workflow: quick`, unless the item names a workflow, is high risk, or the product's default is not feature. The
  runner's guard from ADR 0009 still rebuilds a quick change to a sensitive path through feature.
- **Fewer commands.** `asf` alone shows the board; `asf decide <id> …` gives every decision; `asf run --watch`
  replaces `asf serve`. The older commands keep working.
- **Old role names keep working** in `models`, `runtimes.roles`, workflow files and product override files.
- **A spec is optional**: a small product lists the criteria in the item itself.

## Consequences

- Each role is a job someone on a real team would recognise, and every concern has an owner.
- A plain change costs what it did; a small one costs two agent calls fewer; a change to keys, auth or dependencies
  costs one more call, for the security review. Merging roles saves no tokens by itself: the steps do.
- QA keeps two steps because independence is the point: the tests are fixed before the developer starts.
- The size call is a model's judgement, unmeasured so far; a wrong `small` loses the tests written first, never the
  checks, QA's verdict, the security review or the owner's approval.
