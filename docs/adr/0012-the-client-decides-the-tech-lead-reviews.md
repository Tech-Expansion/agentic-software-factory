# 0012. The owner is the client: the tech lead reviews, the client decides what is theirs

Status: accepted
Date: 2026-11-14
Deciders: project owner

Amends ADR 0006 (what waits for the owner), ADR 0007 (who decides lessons) and ADR 0010 (the roster).

## Context

The owner works with the factory the way a client works with a dev team they hired: they decide what the product does,
what it costs and when it ships, not whether a diff to `package.json` is acceptable. Yet the factory stopped for them
on every change to approval or sensitive paths, on every high-risk item's plan and change, and on every lesson. Those
are a senior engineer's calls. Meanwhile the security reviewer and the UX designer ran on every product whose
changes matched their paths, whether the product needed them or not, and no one reviewed the code as code: QA
judges the criteria, not the design.

On real teams a senior developer or tech lead reviews every change before it is merged, specialists join the
projects that need them, and the client is asked only for decisions with business consequences.

## Decision

- **The architect becomes the tech lead.** It plans high-risk items, as before, and now reviews every change, in
  feature, quick and infra, after QA's verdict, with the `review-code` skill: design, correctness, tests,
  readability, security and accessibility basics, dependencies, pipelines. A blocker sends the change back to the
  developer. `architect` stays an alias.
- **Specialists are opt-in.** The security reviewer's and the UX designer's steps carry `specialist: true` and run
  only for a product that lists the role under `specialists:` in `project.yaml`; then their `when` applies as before.
  In infra the security reviewer, when it is on, reviews every change. The product owner proposes specialists in
  discovery with a reason, and `asf validate` and the board suggest one the settings call for (sensitive paths, a
  `ui` path list). The client turns them on.
- **What waits for the client:**

  | Decision | Who |
  | --- | --- |
  | Requirements, criteria, scope, priority | client |
  | Release into the base branch, deploy | client |
  | A change touching `client_paths` (migrations by default) | client |
  | A decision a reviewer escalates (`escalate` in its verdict): a cost, something irreversible, the agreed architecture | client |
  | A high-risk plan with `client_decisions` | client |
  | Any other high-risk plan | tech lead; the build starts at once |
  | Changes to approval and sensitive paths, high-risk changes | tech lead |
  | Lessons from a retro | tech lead; the client can reverse any of them with `asf decide L-n` |
  | An item still failing after `max_attempts` | client (`asf decide <id> retry`) |

- **A workflow without the tech lead's review keeps the old gates.** If no tech lead step passed the change (a
  product's own workflow without one, an eval ablation), approval and sensitive paths and high-risk items wait for
  the client as before.

## Consequences

- The client is asked fewer and better questions, in their own terms. With an integration branch, most items merge on
  their own and wait only for the release.
- Dependency, CI and deploy-script changes no longer get a human look at merge time. The tech lead's checklist
  covers them; `asf deploy` still lists every approval-path file changed since the last deploy before it runs; a
  product that wants its client to approve them adds the globs to `client_paths`.
- Every item costs one more agent call, the review. A product with sensitive paths no longer pays for a security
  review unless it turns the specialist on.
- The tech lead reviews code whose plan it may have written. It never wrote the code, which is the independence that
  matters, and QA's verdict and the locked tests stay separate from both.
- Whether the tech lead escalates the right things, and only those, is a model's judgement, unmeasured so far.
