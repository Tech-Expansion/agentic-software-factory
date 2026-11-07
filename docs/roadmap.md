# Roadmap to 1.0

Where the factory is going after 0.1, and how we will know it works. Each milestone ends with exit criteria that
are measured, not felt. Hard-to-undo decisions along the way get an ADR.

## What "works" means

**Hard gates, 100%.** Enforced in code and tested, never left to a prompt:

- No code is written for an item that is not Ready.
- No policy breach: protected paths, denied commands, budgets.
- Nothing reaches the base branch without the approval the policy asks for. Sensitive paths always need a person.
- No secret leaves the machine through the factory.

**Measured, at least 95%.** On the eval set (`asf eval`) and on real work:

| Capability | Measured by | Bar |
| --- | --- | --- |
| Understanding a requirement | Eval tickets with planted gaps and conflicts: share of real gaps the analyst asks about, questions about what the ticket already says | ≥95% of gaps asked, ≤1 needless question per ticket |
| Delivering | Hidden acceptance tests written by a person, never shown to the agents | ≥95 of 100 small-to-medium items pass on first delivery, across TypeScript, React and .NET |
| Running unattended | A soak run on an always-on host | 14 days, no item stuck without the owner being told, rate limits recovered from without help |
| Token use | The run log | 0 tokens while there is no work; tokens per item do not regress between versions |

95% is claimed for small-to-medium items in supported stacks. Work that touches keys, signing or money is not built
unattended: the factory clarifies, designs and tests it, and a person reviews every change before it merges.

## Decisions taken (2026-11-07)

1. **Tracker access through the vendor's own CLI.** Jira through Atlassian's `acli`, signed in by the user, like the
   agent CLIs in [ADR 0001](adr/0001-run-inside-the-users-own-agent-cli.md). On a headless host the user may sign
   Claude Code in with a long-lived token from `claude setup-token`; the runner only inherits the environment and
   never reads it.
2. **An always-on Linux VM ("server 2"), reached over SSH,** hosts `asf serve` for unattended runs. Development and
   interactive sessions stay on the owner's machine.
3. **Merge autonomy.** Items that pass checks, review and hidden-risk rules merge into an integration branch on their
   own. The product owner approves releases from it into the base branch in batches. Items that touch sensitive paths
   are approved one by one.
4. **First product: TEX-1, a free Cardano wallet with multi-sig and a person-held gate key.** It exercises the whole
   chain, including the stop-and-ask path. Constraints from the ticket that the factory enforces:
   - Agents work on preprod only. No mainnet key, seed or gate key is ever on the host, in the repo or in CI.
   - Key handling, signing and transaction building are sensitive paths: a security review step and the owner's
     approval for every change.
   - Moving the real funds (TEX-1's first acceptance criterion) is done by the owner by hand, outside the factory.
   - Work items live in the Jira AI project and link back to TEX-1, which stays the owner's epic.

## Milestones

### M0. Measure first

`asf eval` runs a set of cases, each a small product with a backlog and hidden acceptance tests, and reports delivery
rate with its confidence interval, hard-gate breaches, attempts and tokens per item. A baseline for 0.1 is committed
under `evals/baselines/`.

Exit: the baseline exists and a second run on the same version gives comparable numbers.

### M1. Intake and the Definition of Ready

An `analyst` role reads a requirement and returns what it understood, the questions that block it with why they
matter, and the assumptions it would make. An item that needs clarification never reaches a builder; only the owner's
answer moves it to Ready.

Exit: on TEX-1 (read-only) the analyst asks about each open decision (platform, gate structure, owner) and does not
ask again about the security rules already settled. Clarify cases join the eval set.

### M2. A configurable tracker

A `Tracker` interface with a `local` adapter (today's `backlog/`) and a `jira` adapter over `acli`. Questions become
comments that mention the owner and carry a `needs-po` label. Only comments from the configured owner account count
as answers; everything else in a ticket is untrusted data. Jira holds the tickets and the conversation; the repo
holds specs, criteria and code.

Exit: one ticket in the AI project goes from clarification to Ready to built to review through Jira comments alone.

### M3. A team that schedules itself

`asf serve` reacts to events: new tickets, answers, ready items, finished steps. It wakes only the role that has work.
Several builders run in parallel worktrees under a WIP limit, state is locked against concurrent writers, a rate limit
pauses work until the quota resets instead of blocking the item, and a crash resumes or cleanly resets what was
running.

Exit: 10 tickets with 3 builders, a process killed mid-run and restarted, the same outcome; no agent call while idle.

### M4. Status for the owner, at any time

`asf status` shows who is doing what, what waits for the owner, tokens and expected finish. Decisions are queued with
the options and the team's recommendation, and an item waiting on the owner does not hold up others. A daily digest
goes to Jira or Confluence, configurable.

Exit: the owner can follow and steer the work from Jira and the digest without opening a terminal.

### M5. Safe to leave alone

Builders run in a container on the host. `sensitive_paths` in the policy add a security review step and require the
owner's approval. Prompt-injection cases join the eval set.

Exit: every injection case is contained, and no hard gate is breached during the soak run.

### M6. A team that learns

After an item is blocked, rejected or needs several attempts, a short retrospective step writes lessons to
`.factory/memory/`, kept small because memory goes with every call. Improvements to the factory itself (roles,
skills, workflows) are opened as pull requests to this repository with `asf eval` results before and after, and a
person merges them. Learning never loosens the policy.

Exit: a repeated failure is turned into a lesson and stops recurring, shown by the eval numbers.

### M7. Dogfood and soak

TEX-1 and at least one more product in the AI project, plus the factory improving itself, run unattended on server 2
for 14 days and at least 100 items.

Exit: every bar in "What works means" is met. Then 1.0 and the npm release.

## Open risks

- **Subscription terms.** A daemon calling `claude -p` around the clock is close to the open question in ADR 0001.
  Ask Anthropic before promoting the product; API keys remain the fallback.
- **The eval set grades the factory only as well as its cases.** Hidden tests are written or reviewed by a person,
  and cases are added whenever real work finds a failure the set missed.
