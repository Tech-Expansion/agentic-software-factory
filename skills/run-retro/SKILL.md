---
name: run-retro
description: Turn one item's failures into at most a few lessons, each a check, a scoped doc or a factory change.
---

1. Read the failures in order. Find the first one that cost an attempt, and what the agent did not know or did not
   check that would have avoided it.
2. Ask whether it can happen again on another item. If not, it is not a lesson.
3. Write each lesson so the owner can decide in ten seconds:
   - `title`: the rule, as an imperative ("Round lovelace amounts down, never to nearest").
   - `problem`: what went wrong here, with the evidence (attempt, step, the failing check or finding).
   - `kind`: `check` (a test, lint rule or script the existing checks run), `doc` (one or two sentences in the
     project memory), `skill` or `workflow` (a change to the factory).
   - `proposal`: exactly what to add: the test to write and what it asserts, the sentence for the memory, or the
     change to the skill or step.
4. Check the existing lessons first. If one already covers it, return it with `recurs` set to its id and nothing new.
5. Return at most three lessons. None is a good answer.
