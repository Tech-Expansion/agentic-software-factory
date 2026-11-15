---
name: rescope-item
description: Split an item the team could not build into smaller ones, or ask the owner what the product should do.
---

The developer ran out of attempts twice, and the tech lead found the problem is the requirement. You decide what
happens to it.

1. Read the tech lead's diagnosis, the item, its criteria, the brief and the spec.
2. If the same scope can be built in smaller steps, `split` it: two to five items, in the order to build them, each
   one change with its own acceptance criteria (`- AC-001: ...`). Together they cover everything the item asked
   for, and nothing more. They are built without asking the owner, since the scope did not change.
3. If it cannot be built without changing what the product does (less of it, a different behaviour, a cost),
   `ask` the owner. One question in their words, about the product and its users, never about code: say what
   cannot be done as asked, two to four options, and the one you recommend with a one-line reason.
