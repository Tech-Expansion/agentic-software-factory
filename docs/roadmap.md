# Roadmap to 1.0

Where the factory is going after 0.1, and how we will know it works. Each milestone ends with exit criteria that
are measured, not felt. Hard-to-undo decisions along the way get an ADR.

## What "works" means

**Hard gates, 100%.** Enforced in code and tested, never left to a prompt:

- No code is written for an item that is not Ready.
- No policy breach: protected paths, denied commands, budgets, locked acceptance tests.
- Nothing reaches the base branch without the approval the policy asks for. Sensitive paths always need a person.
- No secret leaves the machine through the factory: agent commands and checks run sandboxed, without secrets in their
  environment and without network access beyond an allowlist.

**Measured, at least 95%.** On the eval set (`asf eval`) and on real work:

| Capability | Measured by | Bar |
| --- | --- | --- |
| Understanding a requirement | Eval tickets with planted gaps and conflicts: share of real gaps the analyst asks about, questions about what the ticket already says | ≥95% of gaps asked, ≤1 needless question per ticket |
| Delivering, reliably | Hidden acceptance tests written by a person, never shown to the agents, each case run k times | pass^3 ≥95% on the regression suite; ≥95 of 100 real items accepted on first delivery |
| Running unattended | A soak run on an always-on host | 14 days, no item stuck without the owner being told, rate limits recovered from without help |
| Token use | The run log | 0 tokens while there is no work; tokens per item do not regress between versions |

pass^k is the share of cases that pass in all k trials. It measures what the owner needs, consistency, where a single
run only shows that success is possible.

95% is claimed for small-to-medium items in supported stacks. Work that touches keys, signing or money is not built
unattended: the factory clarifies, plans and tests it, and a person approves the plan and every change before it
merges.

## Decisions taken (2026-11-07)

1. **Tracker access through the vendor's own CLI.** Jira through Atlassian's `acli`, signed in by the user, like the
   agent CLIs in [ADR 0001](adr/0001-run-inside-the-users-own-agent-cli.md). On a headless host the user may sign
   Claude Code in with a long-lived token from `claude setup-token`; the runner only inherits the environment and
   never reads it.
2. **An always-on Linux VM ("server 2"), reached over SSH,** hosts `asf serve` for unattended runs. Development and
   interactive sessions stay on the owner's machine.
3. **Merge autonomy.** Items that pass checks and review merge into an integration branch on their own. The product
   owner approves releases from it into the base branch in batches. Items that touch sensitive paths are approved one
   by one.
4. **First product: TEX-1, a free Cardano wallet with multi-sig and a person-held gate key.** First scope: receive
   and send ADA and native tokens, balances and assets, and m-of-n multi-sig (create, propose, co-sign, submit) with a
   gate key. Constraints the factory enforces:
   - Preprod only. Agents may generate preprod test keys for tests. No mainnet key, seed or gate key is ever on the
     host, in the repo or in CI. Funding test wallets from the faucet is done by the owner.
   - Key handling, signing and transaction building are sensitive paths: the plan and every change need the owner's
     approval.
   - Moving the real funds (TEX-1's first acceptance criterion) is done by the owner by hand, outside the factory.
   - Open product decisions in TEX-1, the platform first, are asked by the analyst, not assumed.
   - Work items live in the Jira AI project and link back to TEX-1, which stays the owner's epic.

## What we took from others (2026-11-07)

Sources and why each point is here: Anthropic's harness and eval posts, OpenAI's harness engineering, Stripe's
Minions, Cursor's planner and workers, Cognition on multi-agents, Spotify's verification loops, Every's compound
engineering, Kent Beck on agents and tests, Simon Willison's lethal trifecta, Dex Horthy and Harper Reed on planning.

1. **Cut one leg of the lethal trifecta.** Private data, untrusted content and a way out together make prompt
   injection an exfiltration channel. Once tickets come from Jira all three are present, so sandboxing comes before
   the tracker, not after it.
2. **Evals that still have signal.** A capability suite that starts with a low pass rate, a regression suite that
   stays near 100%, pass^k over several trials, and transcripts kept for error analysis.
3. **Whoever writes the code does not write its acceptance tests.** Agents delete, skip or bend tests to make them
   pass. A separate step writes tests from the criteria first, the builder cannot change them, and skipped or deleted
   tests fail the item.
4. **The owner reviews plans, not diffs.** A wrong line of research becomes many wrong lines of code. High-risk items
   get a plan the owner approves before any code is written.
5. **Lessons become checks.** A repeated mistake turns into a lint rule, a test or a scoped doc, not into a longer
   prompt. Learning also removes steps that evals show no longer help: every step encodes an assumption about what the
   model cannot do.
6. **Verify like a user.** Products with a UI get end-to-end checks in a browser, which the verifier can run.
7. **Planner and independent workers.** Parallel work only on items that do not touch the same area, no integrator
   agent, orchestration in code. The owner decides with a short command in a comment, which is unambiguous and says
   who decided, rather than by prose.
8. **Fewer round trips.** Checks run inside the builder's session before it may finish, so a failure is fixed in the
   same context, and the number of rounds stays capped.

## Milestones

### M0. Measure first

`asf eval` runs a set of cases, each a small product with a backlog and hidden acceptance tests, and reports delivery
rate with its confidence interval, pass^k over `--trials`, hard-gate breaches, attempts and tokens per case. Cases are
tagged `regression` or `capability`. Agent transcripts are kept. `asf eval --reference` checks the cases themselves
with their own solutions; CI runs it.

Exit: baselines for 0.1 under `evals/baselines/`, a capability suite the current version does not saturate.

### M1. Safe and honest by default

Agent commands and the runner's checks run in a sandbox that fails closed: no network beyond the policy's allowlist,
no reading of credentials, secrets removed from the environment. A tests step writes acceptance tests from the
criteria before the builder starts; the builder cannot change them, and skipped or deleted tests send the item back.
The verifier can run the product's end-to-end checks.

Exit: every injection case is contained, a test-tampering case is caught, and the sandbox refuses to run unsandboxed.

### M2. Intake and the Definition of Ready

An `analyst` role reads a requirement and returns what it understood, the questions that block it with options and a
recommended answer, and the assumptions it would make. An item that needs clarification never reaches a builder; only
the owner's answers move it on. High-risk items get a plan that the owner approves before the build.

Exit: on TEX-1 the analyst asks about each open decision (platform, gate structure, recovery path) and does not ask
again about what the ticket settles. Clarify cases join the eval set.

### M3. A configurable tracker

A `Tracker` interface with a `local` adapter (today's `backlog/`) and a `jira` adapter over `acli`. Questions become
comments with a `needs-po` label; the owner answers and decides in comments (`/approve`, `/reject`), because a comment
says who wrote it and a status change does not ([ADR 0005](adr/0005-tracker-through-acli-decisions-by-owner-comments.md)).
Only the configured owner account counts; everything else in a ticket is untrusted data. Jira holds tickets and the conversation; the repo
holds specs, criteria and code.

Exit: one ticket in the AI project goes from clarification to Ready to built to merged through Jira alone.

### M4. A team that schedules itself

`asf serve` reacts to events: new tickets, answers, ready items, finished steps, and wakes only the role that has
work. Independent items run in parallel worktrees under a WIP limit. Passing items merge into the integration branch;
the owner releases batches into the base branch. A rate limit pauses work until the quota resets instead of blocking
the item. State is locked against concurrent writers, and a crash resumes or cleanly resets what was running. Checks
run inside the builder's session before it may finish.

Exit: 10 items with 3 workers, a process killed mid-run and restarted, the same outcome; no agent call while idle.

### M5. Status for the owner, at any time

`asf status` shows who is doing what, what waits for the owner, tokens and the integration branch's state. Decisions
are queued with the options and the team's recommendation, and an item waiting on the owner does not hold up others.
A digest goes to the tracker.

Exit: the owner can follow and steer the work from Jira and the digest without opening a terminal.

### M6. A team that learns

After an item is blocked, rejected or needs several attempts, a short retrospective proposes lessons as checks, scoped
docs or skill changes. Product changes wait for the owner's approval; factory changes become pull requests to this
repository with `asf eval` numbers before and after. `asf eval --workflow` measures what a step is worth by running
without it. Learning never loosens the policy.

Exit: a repeated failure becomes a check and stops recurring, shown by the eval numbers.

### M7. Dogfood and soak

TEX-1 and at least one more product in the AI project, plus the factory improving itself, run unattended on server 2
for 14 days and at least 100 items.

Exit: every bar in "What works means" is met. Then 1.0 and the npm release.

## Open risks

- **Subscription terms.** A daemon calling `claude -p` around the clock is close to the open question in ADR 0001.
  Ask Anthropic before promoting the product; API keys remain the fallback.
- **The eval set grades the factory only as well as its cases.** Hidden tests are written or reviewed by a person,
  and cases are added whenever real work finds a failure the set missed.
- **The sandbox is only as tight as its allowlist.** A package registry on the allowlist is a way out for anything
  that can publish to it; publishing commands stay denied and registries need no credentials.
