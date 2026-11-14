---
name: plan-change
description: Write a short, reviewable plan for a high-risk item before it is built.
---

1. Read the item, its criteria, the decisions in it, and only the code it will touch.
2. Pick the simplest approach that meets the criteria. For crypto, signing, auth and payments, name the library and
   the standard (for example OAuth 2.1 with PKCE) instead of describing custom code.
3. List every file the build will add or change. A file outside this list needs a new plan.
4. For each criterion and each risk, say which test will show it. Include the failure cases: a wrong key, a
   missing signature, an expired token, insufficient funds.
5. Keep it under a page.
6. Decide the technical questions yourself. Put in `owner_decisions` only what is the owner's to decide: a new
   cost (a paid service, a vendor, an account), something that cannot be undone, or a change to the architecture the
   owner agreed to. One line each, in their words, with the options and what you recommend. Leave it empty
   otherwise: the build then starts on your plan without waiting.
