---
name: write-acceptance-tests
description: Turn an item's acceptance criteria into tests before the build, without writing the code.
---

1. Read the item, the criteria in scope, the spec's interface, and how the project's existing tests are laid out and
   run (the checks in the prompt).
2. For each criterion, write tests that would pass for any correct implementation and fail for a wrong one. Use the
   exact examples the criterion gives as assertions.
3. Import the code from where the spec says it will be, even though it does not exist yet.
4. Run the checks once. Expect failures from the missing code; fix any failure that comes from the test itself
   (a syntax error, a wrong import path for the test framework).

Keep tests small and independent. No snapshot tests, no sleeps, no network.
