# 0009. Product overrides and the quick workflow

Status: accepted
Date: 2026-11-11
Deciders: project owner

## Context

Roles, skills and workflows were read from the factory only. A product that needed one more rule for its builder
("never log a mnemonic") or one more step had to change the factory itself, for every product. And every item ran
the same workflow: a one-line fix paid for a tester and a verifier like a new feature.

BMAD-METHOD solves the first with sparse override files merged over shipped defaults, and the second with a route
per change (one-shot for small ones, a full plan for the rest). We take both ideas, in a smaller form.

## Decision

- **Roles and skills are added to, never replaced.** `.factory/agents/<role>.md` and
  `.factory/skills/<name>/SKILL.md` in a product are appended to the factory's text under "Product rules". A product
  cannot drop the factory's rules; it may bring a role or skill the factory does not have, for its own workflows.
  They are read from the product's main checkout, and `.factory/**` is protected, so a builder cannot change its own
  prompt.
- **Workflows are replaced by name.** `.factory/workflows/<name>.yaml` wins over the factory's `workflows/<name>.yaml`.
  Merging steps into a workflow would make it hard to read what actually runs.
- **The workflow is chosen by the owner:** `workflow:` on the item, else `workflow:` in `project.yaml`, else
  `feature`. A ticket labelled `asf-<name>` is taken in with `workflow: <name>`.
- **`quick`** is build, checks, verify: no acceptance tests written first, two agent calls fewer.
- **The guard is in the runner, not in a prompt.** A `risk: high` item always runs `feature`. A change built without
  a tests step that touches a sensitive path is thrown away and built again through `feature`, tests first, and the
  run log records it as `escalated`. In both cases `feature` (the product's, when it replaced it) must have a tests
  step, or the item is blocked.
- The policy is unchanged: a product still only tightens it. `asf validate` loads every workflow in use and the roles
  and skills it names.

## Consequences

- A product shapes its team in its own repository, in files the owner reviews, and the factory stays one copy.
- A quick item can be wrong in ways a test written first would have caught; the verifier, the checks and the owner's
  release are what is left. That is the trade the owner makes by labelling it.
- An escalated item pays for one build twice. Labelling a change to keys or signing as quick is the mistake this
  costs; it never ships the change untested.
- The analyst does not choose the workflow yet. Letting it would need a measured eval first.
