---
name: verify-against-criteria
description: Decide whether a change meets its acceptance criteria, and return a structured verdict.
---

You get the item, its spec, the check results and the diff against the base branch.

1. For each criterion in scope, find the evidence: the test named after it, or the code path that implements it.
   Read the test and check that it asserts the observable result the criterion states.
2. Read the diff for what tests miss: behavior that broke, scope creep, a secret or a destructive operation.
3. Return the verdict as the JSON the schema asks for:
   - `criteria`: one entry per criterion in scope, with `met`, `not_met` or `unverified` and the evidence in one line.
   - `findings`: problems, each with a severity and one actionable sentence.
   - `summary`: one sentence.
   - `verdict`: `pass` only if every criterion is `met` and there is no `blocker`.

Do not edit files and do not re-run expensive commands; the checks already ran.
