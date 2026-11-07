---
name: plan-change
description: Write a short, reviewable plan for a high-risk item before it is built.
---

1. Read the item, its criteria, the decisions in it, and only the code it will touch.
2. Pick the simplest approach that meets the criteria. For crypto, signing and transaction building, name the library
   and the standard (for example CIP-1854 for multi-sig keys) instead of describing custom code.
3. List every file the build will add or change. A file outside this list needs a new plan.
4. For each criterion and each risk, say which test will show it. Include the failure cases: wrong key, missing
   signature, expired validity, insufficient funds.
5. Keep it under a page.
