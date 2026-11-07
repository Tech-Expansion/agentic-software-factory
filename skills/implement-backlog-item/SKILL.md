---
name: implement-backlog-item
description: Implement one backlog item against its acceptance criteria, tests first.
---

1. Read the item, the criteria in scope and the code you will touch. Use the project's existing structure and style.
2. If the prompt lists locked acceptance tests, they were written from the criteria before you started: read them
   first, and make them pass. You cannot change them. Otherwise, for each criterion in scope, write a test that fails
   without your change, named after the criterion id (for example `AC-001 rejects an empty room name`). Add tests of
   your own for what else you change.
3. Make the smallest change that makes those tests pass.
4. Run the commands from "Checks the runner will run after you" yourself, and fix what fails before you finish.
   Run each exactly as written, from the worktree root: no `cd`, pipes or redirection. Anything else is refused.
5. If this is a retry, the feedback section tells you what failed. Fix that first, and do not undo work that passed.

Keep the diff focused: no drive-by refactors, no reformatting of untouched code, no new dependency unless the item
needs it. Update the docs in `docs/` only when the item changes how the product is set up or used.
