# Text helpers

`src/text.js` holds small text helpers. Tests live in `test/` and run with `node --test`.

## Acceptance criteria

- AC-001: `isPalindrome(text)` is true when the letters and digits of `text` (any script), compared without regard to
  case, read the same backwards: "A man, a plan, a canal: Panama", "No 'x' in Nixon", "12321", "Ana".
- AC-002: It is false when they do not ("hello", "12345"), and for text that has no letters or digits ("", "!!").
- AC-003: A value that is not a string throws a `TypeError`.
- AC-004: `squish` keeps working as it does now.
