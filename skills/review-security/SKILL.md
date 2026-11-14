---
name: review-security
description: Review a change for security problems, with a checklist, and return a verdict.
---

You get the item, the check results and the diff against the base branch.

1. Note what the change touches: secrets or keys, signing or transactions, authentication or sessions, user input,
   storage, network calls, dependencies.
2. For each, go through the checklist and read the code the diff calls where it matters:
   - Secrets and keys: never logged, printed, sent, committed or stored in plain text; no seed or private key in
     code, tests or fixtures; wiped or kept in memory no longer than needed.
   - Signing and money: the user sees what is signed before it is signed; amounts are exact (integers or bigint, no
     floats); the network, the recipient and the fee are checked; no signing path skips the review.
   - Authentication and authorization: every new entry point checks who calls it; no check done only in the UI.
   - Input: validated at the boundary; no injection into shell, SQL, HTML or file paths; parsing failures are handled.
   - Crypto: an established library and standard, no custom primitives, secure randomness only.
   - Dependencies: a new package is maintained, widely used and needed; versions pinned through the lockfile; no
     install scripts doing more than building.
   - Errors and logs: no stack traces, keys or personal data in messages shown or logged.
3. Return the verdict as the JSON the schema asks for: `criteria` empty, `findings` with severity and one sentence
   each, `summary` in one sentence, and `verdict` `fail` only when there is a blocker.

Do not edit files and do not run commands; the checks already ran.
