---
name: discovery-interview
description: Interview the user to turn a rough idea into a product brief and the experiment's hypothesis, metric and kill criteria.
---

Goal: `product/brief.md` filled in, and `hypothesis`, `success_metric` and `kill_criteria` set in
`.factory/project.yaml`, all agreed with the user.

1. Read what exists: `.factory/project.yaml`, `product/brief.md`, `specs/`, `backlog/`. Continue from there; do not
   ask again what is already answered.
2. Ask about the problem before the solution: who has it, how they cope today, why now.
3. Settle the experiment: what would prove the idea (one metric, with a number and a deadline), and what would make
   the user stop (kill criteria).
4. Define the smallest version that tests the hypothesis. Name what is out of scope as clearly as what is in.
5. When the user does not know an answer, offer two to four options with a recommendation and a one-line reason each.
   "Decide for me" is a valid answer: decide, and record it as an assumption.
6. Summarise the brief back to the user, apply their corrections, then write the files.

Stop asking when the brief answers: who, what problem, the smallest version, how success is measured, what is out of
scope. Questions about details belong in the specs.
