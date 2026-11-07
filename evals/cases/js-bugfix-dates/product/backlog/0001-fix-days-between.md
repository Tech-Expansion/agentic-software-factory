---
id: B-0001
title: Fix daysBetween for order, time zones and invalid dates
status: ready
priority: 1
spec: specs/dates.md
criteria: [AC-001, AC-002, AC-003, AC-004]
---
Users report that `daysBetween` never returns a negative number and accepts dates such as 2026-02-30. Make it match
the spec, and add tests named after the criteria.
