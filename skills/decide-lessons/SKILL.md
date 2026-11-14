---
name: decide-lessons
description: Accept or reject the lessons the scrum master proposed after an item, as the tech lead.
---

You get the item, what went wrong on it, and the lessons proposed from it.

1. For each lesson, ask: would it have prevented this mistake, and will it prevent the next one like it? Is it cheap
   to follow? Does an accepted lesson or an existing check already cover it?
2. Accept it if the answers are yes, yes, yes and no. Reject it if it is vague, one-off, already covered, or costs more
   than the mistake. A `check` is the stronger kind: prefer it when the mistake came back after a `doc` lesson.
3. Return one decision per lesson, as the JSON the schema asks for, each with its reason in one sentence.

Accepting a lesson never changes the policy: a check becomes a backlog item, a doc a line in the product memory, and a
factory lesson a proposal measured before it is adopted. The owner can reverse any decision.
