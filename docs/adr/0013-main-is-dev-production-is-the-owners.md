# 0013. Main is the development line, production is the owner's; failures go up the team first

Status: accepted
Date: 2026-11-15
Deciders: project owner

Supersedes the integration branch of ADR 0006. Amends ADR 0011 (who deploys) and ADR 0012 (what reaches the owner).

## Context

The owner works with the factory as a client works with a team they hired. Three things still pulled them into the
team's work:

- **Every item waited for them.** Auto-merge needed `integration_branch`, which the template did not set, so by
  default each item stopped for `asf decide approve`. The owner could not see the product running without releasing.
- **A failing item went straight to them.** After `max_attempts` it was blocked, with `retry` as the only answer,
  though the cause was usually something the tech lead or the product owner could settle.
- **The product owner asked technical questions.** "Which platform?" and the choice of stack were put to the owner,
  who knows the users and the budget, not the frameworks.

Real teams keep a development line that deploys on its own to a dev environment, release to production on the
client's word, and escalate a stuck task to the lead before the client hears of it.

## Decision

- **Branches.** `base_branch` (main) is the development line: an item that passes its checks and review merges into
  it on its own. `production_branch` (production, created from main the first time) is what is live, and only the
  owner's release moves it. With a `remote`, `asf release` pushes main and opens or updates a pull request from main
  into production with release notes (each item's title and what the product owner understood); the owner merges it,
  with a merge commit. Without one, `asf release` merges locally. Items are done once production contains their merge.
- **Merges happen in the item's worktree**, and main then moves forward to the result, so the owner's checkout never
  has to be clean or on main. An item measures its changes from where it forked, so items built in parallel do not
  see each other's merges as their own.
- **Dev deploys itself** after each merge, as `dev_deploy` says. `run: push` pushes main and leaves the deploy to the
  hosting or CI; this is the preferred way, since the credentials stay with the platform. `run: commands` runs
  `deploy.dev` in a worktree of its own, sandboxed like the checks, seeing only the secrets named in `env` and
  reaching only the package registries and the hosts in `network`. While it is on, a change to the policy's
  `deploy_paths` (CI, deploy scripts, infrastructure) waits for the owner: it would run at once with those
  credentials. `asf deploy <env>` stays the owner's: dev deploys main, every other environment production.
- **Escalation.** When the developer runs out of attempts, the tech lead diagnoses the cause. If the code is the
  problem, it plans the item again and the developer gets a fresh set of attempts, once. If the requirement is the
  problem, or the new plan fails too, the product owner splits the item into smaller ready items with the same scope,
  or asks the owner what the product should do. Only that question reaches the owner, in business terms with options
  and a recommendation; `asf decide <id> retry "<answer>"` gives the answer to the team.
- **Business questions only.** The product owner asks what the technology depends on in the owner's words (phone or
  computer, offline, how many people, what it may cost to run) and never about the technology. When `asf discover`
  ends and the product has no checks, the tech lead chooses the stack from the brief, records it as an ADR and sets
  the commands.
- **Two workers** by default for `asf run --watch`.

## Consequences

- The owner sees the product grow on dev without doing anything, and decides only when it goes live, what costs
  money or cannot be undone, and what the product should do when the team cannot build it as asked.
- Main moves while the owner works in their checkout. A fast-forward keeps their uncommitted changes and refuses only
  when they touch the same files; the item then waits, with the reason.
- A dev deploy with `run: commands` runs code the agents wrote with a dev credential. The sandbox limits what it can
  reach and see, and the owner approves changes to what runs it; a production credential is never given to it.
- A merged item can no longer be rejected; a change to it is a new request, and goes out in the same release.
- A squash or rebase merge of the release pull request hides which items were released; the notes say to merge it
  with a merge commit.
- Escalation costs up to two more read-only calls on an item that would have blocked anyway, and one more round of
  attempts. The diagnosis, the split and the questions are a model's judgement, measured in the pilot.
