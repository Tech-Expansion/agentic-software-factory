# 0014. The sandbox is opt-in

Status: accepted
Date: 2026-11-15
Deciders: project owner

Amends ADR 0004 (every agent command and check runs sandboxed, failing closed), ADR 0013 (a dev deploy with
`run: commands` is sandboxed) and the roadmap's hard gate on secrets.

## Context

ADR 0004 put every agent command and every check in a sandbox that failed closed; the only way out was the
operator's `ASF_UNSAFE_NO_SANDBOX=1`. The first day of the pilot showed what that costs. Two of its three items lost
a build to the sandbox rather than to the work: pnpm could not open its store lock, npm could not verify TLS through
the macOS keychain, a package that was not in the cache could not be downloaded. Each was fixed in the factory, and
each new stack will bring its own.

Claude Code's sandbox runs on macOS, Linux and WSL2. On native Windows it does not exist, so the factory could not
run there at all.

The people the factory is for, an owner who is not technical and a developer who already lets an agent run commands
on their machine, expect it to work once it is installed.

## Options considered

1. **Keep the sandbox on by default.** The strongest default, and the one that fails most often on a new machine or
   a new stack, for the users least able to tell why.
2. **Make it a setting a product turns on.** It works when installed; the products that need the isolation ask for
   it, and get the same sandbox as before.
3. **Remove it.** Less code, but nothing left for a product that handles keys, money or personal data.

## Decision

We take option 2.

- `sandbox.enabled` in the policy is `false` by default. A product turns it on in `.factory/policy.yaml`. The
  operator turns it on for every product on a machine with `ASF_SANDBOX=1` (an always-on host, CI). Turning it on
  tightens, so a product cannot turn off a sandbox the operator forced on. `ASF_UNSAFE_NO_SANDBOX` is gone.
- **Off:** a builder on Claude Code may run any command that is not on `denied_commands`. Before, an unsandboxed
  builder could run only the setup and check commands, which is not enough to build: it cannot install a dependency.
  Read-only steps keep to the read tools and `git status|diff|log|show`. The Read tool is denied the
  `sandbox.deny_read` paths either way. Checks run without secrets in their environment.
- **On:** as in ADR 0004. Where it is on and cannot run (native Windows, `srt` not installed) nothing starts, and
  the error says how to go on.
- What the runner enforces after each step does not depend on the sandbox: protected paths are put back, acceptance
  tests stay locked, deleted or skipped tests and anything that looks like a secret send the item back, budgets
  hold, and nothing reaches the base branch without the owner.
- CI builds the eval cases in the sandbox on Linux and macOS, so the sandbox stays tested.

Checked on 2026-11-15 with Claude Code 2.1.325: with `--permission-mode dontAsk`, `--allowedTools` holding `Bash` and
`--disallowedTools` holding `Bash(curl:*)`, a `curl` command is refused and reported in `permission_denials`, and
other commands run.

## Consequences

- The factory installs and runs with nothing but Node.js, git and a CLI, on macOS, Linux and Windows.
- Without the sandbox, "no secret leaves the machine through the factory" is not enforced. A command an agent runs
  has the user's access: it can read what the user can read and reach any host. `denied_commands` matches the start
  of a command; it stops mistakes, not an agent that was talked into something by a dependency, a ticket or a file
  in the repository. Unattended agents still have no web tools.
- A product should turn the sandbox on when it handles keys, money or personal data, runs on an always-on host, or
  takes tickets written by people other than the owner.
- A dev deploy with `run: commands` (ADR 0013) still sees only the secrets named for it, but it reaches only the
  listed hosts when the sandbox is on. `run: push`, which leaves the credentials with the hosting, stays the
  preferred way.
- Codex is unchanged: it runs in its own sandbox, and starts without secrets in its environment.
