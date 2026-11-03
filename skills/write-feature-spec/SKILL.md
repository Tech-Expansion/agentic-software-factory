---
name: write-feature-spec
description: Write a feature spec with numbered, testable acceptance criteria.
---

One spec per feature, in `specs/<feature>.md`:

```markdown
# <Feature name>

Status: draft | approved

## Why
One or two sentences: which user, which need from the brief.

## Behavior
What the user can do, step by step. Plain words, no implementation.

## Acceptance criteria
- AC-001: Given <state>, when <action>, then <observable result>.
- AC-002: ...

## Edge cases
Empty input, limits, errors, concurrency: each one either an AC or explicitly out of scope.

## Out of scope
## Open questions
```

Rules:

- Every criterion is observable and testable from outside: a test can decide it without reading the code.
- Number criteria `AC-001`, `AC-002`, ... within the spec. Never reuse or renumber a published id; retire it instead.
- Mark the spec `approved` only after the user agrees. A spec with open questions that affect a criterion is not
  approved.
- Keep it short. A spec the builder has to read in full on every attempt costs tokens on every attempt.
