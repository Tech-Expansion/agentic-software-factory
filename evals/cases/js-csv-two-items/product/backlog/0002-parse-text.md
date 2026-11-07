---
id: B-0002
title: Parse CSV text into objects
status: ready
priority: 2
depends_on: [B-0001]
spec: specs/csv.md
criteria: [AC-004, AC-005]
---
Add `parseCsv` to `src/csv.js`, built on `parseCsvLine`, with tests named after the criteria.
