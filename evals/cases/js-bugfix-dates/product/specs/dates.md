# Date helpers

## Interface

`src/dates.js` exports `daysBetween(from, to)`. Both arguments are calendar dates written as "YYYY-MM-DD".
Tests live in `test/` and run with `node --test`.

## Acceptance criteria

- AC-001: Returns the number of calendar days from `from` to `to`: positive when `to` is later, negative when it is
  earlier, 0 for the same day. `daysBetween("2026-03-10", "2026-03-01")` is -9.
- AC-002: The result does not depend on the machine's time zone or on daylight saving changes.
- AC-003: Anything that is not a real calendar date in exactly the "YYYY-MM-DD" form throws a `RangeError` whose
  message contains the bad value. That includes "2026-02-30", "2026-2-3", "03/04/2026", "" and values that are not
  strings.
- AC-004: Leap years are handled: from "2024-02-28" to "2024-03-01" is 2 days, from "2023-02-28" to "2023-03-01" is 1.
