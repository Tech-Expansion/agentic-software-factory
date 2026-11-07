# Slugify

Turns a title into a URL slug. Most titles are Vietnamese.

## Interface

`src/slugify.ts` exports `slugify(input: string, options?: { maxLength?: number }): string`.

The code runs on Node's built-in TypeScript support, so it uses erasable syntax only: no enums, namespaces or
parameter properties. Tests live in `test/` as `*.test.ts` and run with `node --test`.

## Acceptance criteria

- AC-001: The result is lower-case ASCII. Diacritics are removed, so "Tiếng Việt" becomes "tieng-viet", and "đ" and
  "Đ" become "d".
- AC-002: Every run of characters other than a-z and 0-9 becomes a single "-", and the result never starts or ends
  with "-": "  Hello,  World!! " becomes "hello-world".
- AC-003: With `maxLength`, the result is at most that long and is cut between words, never inside one:
  `slugify("xin chao the gioi", { maxLength: 12 })` is "xin-chao-the". If the first word alone is longer than
  `maxLength`, it is cut at `maxLength`.
- AC-004: Input with nothing to keep, such as "" or "!!!", gives "".
