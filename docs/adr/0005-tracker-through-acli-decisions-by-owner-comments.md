# 0005. Trackers through the vendor's CLI, and the owner decides in comments

Status: accepted
Date: 2026-11-07
Deciders: project owner

## Context

The owner wants to hand work to the team as Jira tickets, answer its questions and decide on its work there, without
opening a terminal. Tickets and comments are text anyone with access to the project can write, and that text reaches
agents' prompts: it is untrusted data.

The roadmap said the owner would decide by moving a ticket, because a status is unambiguous. A status change, though,
does not say who made it unless the changelog is read, and `acli` has no documented way to read it. Anyone who can
move a ticket could then approve a merge.

Facts checked on 2026-11-07 against Atlassian's `acli` reference pages (the CLI itself was not installed yet):
`acli jira workitem search --jql ... --json --paginate`, `comment create --key --body`, `comment list --key --json
--paginate`, `transition --key --status --yes`, `edit --key --labels/--remove-labels --yes`. The shape of the JSON
output is not documented.

## Decision

- Tracker access goes through the vendor's own CLI, signed in by the user, like the agent CLIs
  ([ADR 0001](0001-run-inside-the-users-own-agent-cli.md)). Jira is the first adapter; with no tracker configured,
  `backlog/` is the tracker.
- `asf sync` does the exchange without calling a model. Tickets the owner reported, in the intake status, become
  `new` items in the repository; questions and results are posted as comments that start with `[asf]`; the owner's
  answers and decisions are read from their comments.
- Decisions are commands in a comment by the configured owner account: `Q1: <answer>`, `/accept`, `/approve`,
  `/reject <reason>`, `/retry`. Comments by anyone else, and the factory's own (`acli` posts them as the owner), are
  never acted on. The factory moves tickets between statuses to show where work is; a status never decides anything.
- Intake asks Jira for the owner's tickets only and checks the reporter again on what comes back.
- The JSON from `acli` is read defensively, from the shapes of Jira's REST API it wraps.

## Consequences

- The owner types a short command instead of dragging a card. In exchange, nobody else with access to the project
  can approve, answer or retry.
- The parsing of `acli`'s JSON must be checked against the real CLI before the first real ticket, and this ADR
  updated with the versions; until then the Jira adapter is unverified.
- Ticket text written by the owner still goes to agents, read-only and sandboxed. A ticket is no more trusted than
  any other input; the sandbox in [ADR 0004](0004-sandbox-agent-commands-and-checks.md) is what contains it.
