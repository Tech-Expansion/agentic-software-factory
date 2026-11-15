# Roadmap to 1.0

How we will know the factory works, what is built, and what is left. Bars are measured, not felt. Hard-to-undo
decisions get an ADR.

## What "works" means

**Hard gates, 100%.** Enforced in code and tested, never left to a prompt:

- No code is written for an item that is not Ready.
- No policy breach: protected paths, denied commands, budgets, locked acceptance tests.
- Nothing reaches the base branch without the owner's release. A change to `owner_paths`, or one a reviewer
  escalates, waits for the owner however it was reviewed.
- Nothing that looks like a secret is committed, and checks run without secrets in their environment.
- With the sandbox on (opt-in, ADR 0013), no secret leaves the machine through the factory: agent commands and checks
  run sandboxed, without network access beyond an allowlist. Without it, a command an agent runs has the owner's
  access.

**Measured, at least 95%.** On the eval set (`asf eval`) and on real work:

| Capability | Measured by | Bar |
| --- | --- | --- |
| Understanding a requirement | Eval tickets with planted gaps: share of gaps the product owner asks about, questions about what the ticket already says | ≥95% of gaps asked, ≤1 needless question per ticket |
| Delivering, reliably | Hidden acceptance tests written by a person, never shown to the agents, each case run k times | pass^3 ≥95% on the regression suite; ≥95 of 100 real items accepted on first delivery |
| Asking the owner only what is theirs | Real items: escalations and plan decisions the owner would have made the same way without being asked | ≤1 needless question per 10 items, no missed one |
| Running unattended | A soak run on an always-on host | 14 days, no item stuck without the owner being told, rate limits recovered from without help |
| Token use | The run log | 0 tokens while there is no work; tokens per item do not regress between versions |

pass^k is the share of cases that pass in all k trials: consistency, which is what the owner needs.

## Principles we took from others

From Anthropic's harness and eval posts, OpenAI's harness engineering, Stripe's Minions, Cursor's planner and
workers, Cognition on multi-agents, Spotify's verification loops, Every's compound engineering, Kent Beck on agents
and tests, Simon Willison's lethal trifecta, Dex Horthy and Harper Reed on planning.

1. **Cut one leg of the lethal trifecta.** Private data, untrusted content and a way out together turn prompt
   injection into exfiltration, so unattended agents never browse the web, and a product that holds private data
   turns the sandbox on.
2. **Evals that still have signal.** A capability suite that starts low, a regression suite near 100%, pass^k over
   several trials, transcripts kept for error analysis.
3. **Whoever writes the code does not write its acceptance tests**, and cannot change, skip or delete them.
4. **The owner decides outcomes, not diffs.** The tech lead plans risky work and reviews every change; the owner is
   asked about scope, cost and what cannot be undone.
5. **Lessons become checks**, not longer prompts, and steps the evals show no longer help are removed.
6. **Verify like a user.** Products with a UI get end-to-end checks QA can run.
7. **Orchestration in code.** Parallel work only on items that do not touch the same area; decisions are short
   commands that say who decided.
8. **Fewer round trips.** Checks run inside the developer's session before it may finish.

## Where we are (2026-11-14)

Built and covered by tests with a fake runtime:

- Evals with hidden tests and pass^k; the sandbox, opt-in; acceptance tests written first and locked (ADR 0004,
  0013).
- Intake and the Definition of Ready: the product owner scans the market in discovery, clarifies and sizes items.
- Product overrides of roles, skills and workflows, and a quick workflow for small changes (ADR 0009).
- A product team: product owner, developer, QA and tech lead on every item; security reviewer and UX designer as
  opt-in specialists; DevOps for infrastructure, deployed by the owner (ADR 0010, 0011, 0012).
- Unattended runs with `asf run --watch`, the board, an integration branch with batch releases (ADR 0006).
- Retros whose lessons become checks, decided by the tech lead (ADR 0007, 0012).
- Jira through `acli` (ADR 0005), not yet checked against the real `acli`.

Designed, not built: SRE (ADR 0011).

## Next

### M7. Pilot

One small new product, five to eight items, built with real models end to end.

Exit: delivery rate, tokens per item and every question the owner was asked are recorded; what went wrong becomes
eval cases or lessons; a new baseline under `evals/baselines/`.

### M8. Soak

At least two products and the factory improving itself, unattended on an always-on host for 14 days and at least
100 items.

Exit: every bar in "What works means" is met. Then 1.0 and the npm release.

## Open risks

- **Subscription terms.** A daemon calling `claude -p` around the clock is close to the open question in ADR 0001.
  Ask Anthropic before promoting the product; API keys remain the fallback.
- **The eval set grades the factory only as well as its cases.** Hidden tests are written or reviewed by a person,
  and cases are added whenever real work finds a failure the set missed.
- **The sandbox is off by default, and only as tight as its allowlist when on.** Off, an agent's command can read
  and send what the owner can (ADR 0013). On, a package registry on the allowlist is a way out for anything that can
  publish to it; publishing commands stay denied and registries need no credentials.
- **Judgement calls are unmeasured.** The size call, the tech lead's escalations and lesson decisions, and the market
  scan are a model's judgement until the pilot measures them.
