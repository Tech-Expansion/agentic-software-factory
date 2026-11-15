---
name: clarify-requirement
description: Read a requirement, find what is open or contradictory, and ask the owner only what matters.
---

1. Read the requirement, its spec and criteria if any, and the product brief. Look in the code only to answer a
   question yourself.
2. List what someone building this would have to decide: who uses it and where, inputs and outputs, edge cases,
   errors, limits, security and money, what "done" looks like. Strike out everything the text or the code settles.
3. For each decision left, ask: if the team guesses, what is the cost of a wrong guess? High cost: a blocking
   question. Low cost: an assumption.
4. Ask in the owner's words, about the product and its users: "on a phone, a computer, or both?", never "which
   platform?". A technical choice is never a question: the tech lead decides it.
5. Merge questions that one answer settles together. Prefer few, sharp questions with concrete options over many
   open ones.
6. Check each question against the text once more: if the answer is already there, drop it.
7. Size the item. `small` only when it is one clear change to a few files and nothing above was left to decide;
   it is then built without acceptance tests written first. Anything touching money, keys, auth or data is `normal`.
