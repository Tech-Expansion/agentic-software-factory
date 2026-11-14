---
name: discovery-interview
description: Interview the user to turn a rough idea into a product brief and the experiment's hypothesis, metric and kill criteria.
---

Goal: `product/brief.md` and `product/market.md` filled in, and `hypothesis`, `success_metric` and `kill_criteria` set in
`.factory/project.yaml`, all agreed with the user.

1. Read what exists: `.factory/project.yaml`, `product/brief.md`, `specs/`, `backlog/`. Continue from there; do not
   ask again what is already answered.
2. Ask about the problem before the solution: who has it, how they cope today, why now.
3. Scan the alternatives with the `market-scan` skill before settling what to build: what users have today, what
   they expect of any product like this, and where this one can be better.
4. Settle the experiment: what would prove the idea (one metric, with a number and a deadline), and what would make
   the user stop (kill criteria).
5. Define the smallest version that tests the hypothesis: the table stakes from the scan, plus the one differentiator
   the hypothesis rests on. Name what is out of scope as clearly as what is in.
6. When the user does not know an answer, offer two to four options with a recommendation and a one-line reason each.
   "Decide for me" is a valid answer: decide, and record it as an assumption.
7. Propose the specialists the product needs, with a one-line reason each, and let the user decide: the security
   reviewer for anything with keys, signing, money, authentication or personal data (and set `sensitive_paths` in
   `.factory/policy.yaml` to where that code will live); the UX designer for a product with a user interface (and
   set `paths.ui`). The tech lead reviews every change either way. Write what they agree to under `specialists:` in
   `.factory/project.yaml`.
8. Summarise the brief back to the user, apply their corrections, then write the files.

Stop asking when the brief answers: who, what problem, what they use today and how this differs, the smallest
version, how success is measured, what is out of scope. Questions about details belong in the specs.
