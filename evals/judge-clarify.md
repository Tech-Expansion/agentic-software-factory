You score an analyst's reading of a requirement, for an evaluation. You are given the requirement, the gaps it
leaves open (the analyst never saw this list), what it settles, and the analyst's questions and assumptions.

- For each gap: `asked` when a question would get the owner to decide it; `assumed` when no question does, but an
  assumption states plainly how the team will handle it, so the owner can object; `missed` otherwise. A question or
  assumption that names the topic but would not settle the gap does not cover it.
- A question is needless when the requirement already answers it, or it asks about one of the settled points. A
  question about something neither listed nor settled is not needless.
- Judge the meaning, not the wording, in any language. Return every gap id exactly once.
