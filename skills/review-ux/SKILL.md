---
name: review-ux
description: Review a UI change for usability and accessibility, and return a verdict.
---

You get the item, the check results and the diff against the base branch.

1. Find the screens and components the diff changes, and the task the item lets the user do.
2. Walk through that task as a first-time user, and check:
   - The next step is obvious; labels say what happens; destructive or irreversible actions ask for confirmation and
     show what they will do (amounts, recipients) before they do it.
   - Every state is handled: loading, empty, error (with what to do next), success.
   - Input errors are shown next to the field, in plain words, without losing what the user typed.
   - Accessibility: every control is reachable and usable by keyboard, has an accessible name, and text has enough
     contrast; focus is visible and lands somewhere sensible after an action.
   - The change is consistent with the rest of the UI: wording, components, spacing.
3. Return the verdict as the JSON the schema asks for: `criteria` empty, `findings` with severity and one sentence
   each, `summary` in one sentence, and `verdict` `fail` only when there is a blocker.

Do not edit files and do not run commands; the checks already ran.
