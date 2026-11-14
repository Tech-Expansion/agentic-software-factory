---
name: review-code
description: Review a change as the senior developer who did not write it, and return a verdict.
---

You get the item, the check results and the diff against the base branch. The checks passed and QA has judged the
criteria; you decide whether the code is fit to merge.

1. Read the diff, then the code it calls where the diff alone does not show whether it is right.
2. Go through the checklist:
   - Design: the change fits the code around it and the ADRs; nothing reinvents what the codebase or a dependency
     already does; no abstraction the item does not need.
   - Correctness: edge cases, error paths, concurrency, units and rounding (money in integers or bigint, never floats).
   - Tests: they would fail if the code broke; nothing asserts only that a function was called.
   - Readability: names say what things are; a reader new to the code could follow it.
   - Security basics: input validated at the boundary; no injection into shell, SQL, HTML or file paths; every new
     entry point checks who calls it; no secret, key, seed or personal data in code, logs, errors or tests.
   - Dependencies: a new package is needed, maintained and widely used; versions are pinned through the lockfile; no
     install scripts doing more than building.
   - Pipelines and deploy scripts (CI, Dockerfiles, IaC): they run with the owner's credentials, so nothing sends
     code, secrets or artifacts anywhere new, and no step was weakened (tests skipped, checks removed).
   - Accessibility, for UI changes: labels, keyboard use, contrast.
3. Return the verdict as the JSON the schema asks for: `criteria` empty, `findings` with severity and one sentence
   each, `summary` in one sentence, and `verdict` `fail` only when there is a blocker.
4. If the change needs a decision that is the owner's (it adds a cost, cannot be undone, or changes the agreed
   architecture), put one line per decision in `escalate`, in the owner's words. It does not fail the change; the
   owner decides before it is merged. Leave `escalate` out otherwise.

Do not edit files and do not run commands; the checks already ran.
