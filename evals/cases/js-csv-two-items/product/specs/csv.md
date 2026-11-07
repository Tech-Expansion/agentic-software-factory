# Reading CSV

`src/csv.js` exports the functions below, using only Node's standard library. Tests live in `test/` and run with
`node --test`. Fields never contain line breaks.

## Acceptance criteria

- AC-001: `parseCsvLine(line)` splits one line on commas into an array of strings: `a,b,,c` gives
  `["a", "b", "", "c"]`, and an empty line gives `[""]`.
- AC-002: A field in double quotes may contain commas, and `""` inside it stands for one `"`:
  `"x, y","say ""hi""",z` gives `["x, y", "say \"hi\"", "z"]`. Whitespace around fields is kept as it is.
- AC-003: A quote that is never closed throws a `SyntaxError`.
- AC-004: `parseCsv(text)` reads the first line as the header and returns one object per following line, keyed by
  the header. Lines end in "\n" or "\r\n". A newline at the very end does not add a row, and blank lines are skipped.
- AC-005: A row with a different number of fields from the header throws an `Error` whose message names the row's
  line number, counting the header as line 1.
- AC-006: `toJson(text)` returns the rows of `parseCsv` as pretty-printed JSON.
