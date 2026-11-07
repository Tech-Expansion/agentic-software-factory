---
name: plan-backlog
description: Split approved specs into backlog items the builder can do in one unattended run.
---

One file per item in `backlog/NNNN-<slug>.md`:

```markdown
---
id: B-0001
title: Create a room
status: draft
priority: 1
spec: specs/rooms.md
criteria: [AC-001, AC-002]
depends_on: []
---
Notes the spec does not say: where the code should go, what to reuse, what to leave alone.
```

Rules:

- An item is small enough for one run: a few files, one coherent change, its criteria testable in that change.
  If an item needs more than about five criteria, split it.
- Order by dependency, then by what tests the hypothesis soonest. The first item usually sets up the stack, so that
  `commands.check` in `.factory/project.yaml` runs real lint, build and tests.
- Every criterion of an approved spec belongs to exactly one item.
- `status: ready` only for items the user agreed to, whose spec is approved and whose dependencies are known.
- Run `asf validate` when you are done and fix what it reports.
