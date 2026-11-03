---
name: implement-backlog-item
description: Implement one backlog item against its acceptance criteria, tests first.
---

1. Read the item, the criteria in scope and the code you will touch. Use the project's existing structure and style.
2. For each criterion in scope, write or extend a test that fails without your change. Name the test after the
   criterion id (for example `AC-001 rejects an empty room name`) so the verifier can find it.
3. Make the smallest change that makes those tests pass.
4. Run the commands from "Checks the runner will run after you" yourself, and fix what fails before you finish.
5. If this is a retry, the feedback section tells you what failed. Fix that first, and do not undo work that passed.

Keep the diff focused: no drive-by refactors, no reformatting of untouched code, no new dependency unless the item
needs it. Update the docs in `docs/` only when the item changes how the product is set up or used.
