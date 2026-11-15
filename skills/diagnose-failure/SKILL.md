---
name: diagnose-failure
description: Find out why an item kept failing, and plan it again or hand it to the product owner.
---

The developer ran out of attempts on this item. Before anyone else is asked, you find out why.

1. Read what went wrong in each attempt, the item and its criteria, and the code in the worktree. Look for the one
   cause behind the failures, not the last symptom.
2. If the team can build it with a different approach, the cause is `code`. Write the new approach in `plan`: what
   to do differently, the files, and how each criterion will be shown. The developer gets a fresh set of attempts
   on your plan.
3. If the item cannot be built as written (it is too big for one change, its criteria contradict each other, or it
   needs something the product does not have), the cause is `requirement`. Leave `plan` empty; the product owner
   splits the item or asks the owner.
4. Never hand the owner a technical question. A cost or something that cannot be undone goes to the product owner
   as `requirement`, with the facts in `diagnosis`.
