# 0004. Sandbox agent commands and checks, and keep secrets out of them

Status: accepted
Date: 2026-11-07
Deciders: project owner

## Context

Unattended runs put three things together that make prompt injection an exfiltration channel (Simon Willison's
"lethal trifecta"): private data on the host, untrusted content in tickets and code, and a way to send data out. Once
tickets come from Jira all three are present.

The concrete paths we found on our own setup:

- On a headless host the user signs Claude Code in with `CLAUDE_CODE_OAUTH_TOKEN`. Every command an agent runs, and
  every check the runner runs (which executes code the agent wrote), inherited it, and could reach any host.
- The Read tool is not covered by any shell sandbox, so an agent could read `~/.claude` or `~/.ssh` and write what it
  found into the repository, where a later push publishes it.
- Codex in `workspace-write` has no network, but its exec mode passes the whole environment to its commands; its
  `shell_environment_policy` did not change that in codex-cli 0.147.0.

Facts checked on 2026-11-07 with Claude Code 2.1.316, codex-cli 0.147.0 and `@anthropic-ai/sandbox-runtime` 0.0.81
on macOS, and in a Linux container (Debian, bubblewrap) for `srt`:

- `claude --settings <json>` accepts a `sandbox` block. With `failIfUnavailable` and `allowUnsandboxedCommands: false`
  Bash runs sandboxed or not at all; `network.allowedDomains` blocked other hosts (403 from its proxy),
  `filesystem.denyRead` hid `~/.claude`, and `credentials.envVars` with `mode: deny` removed a variable.
- `srt --settings <file> -c <command>` applies the same kind of rules to any process. It requires
  `network.deniedDomains` and `filesystem.denyWrite` to be present. `node --test` ran normally inside it.
- `srt` points `TMPDIR` at `/tmp/claude` without creating it; MSBuild then fails to make its temp folder. On Linux a
  path is only made writable if it exists, so a first `dotnet restore` found `~/.dotnet` read-only.
- On Linux `srt` keeps `.gitmodules` (one of its "dangerous files") unreadable when it is absent, and MSBuild's
  source-control queries fail on it. They only stamp commit information into build output.
- `dotnet test` talks to its test host over a loopback TCP socket. On macOS that needs `network.allowLocalBinding`,
  which allows binding anywhere and connecting to every local port of the host, and .NET must use IPv4, because the
  Seatbelt rule does not match its dual-stack sockets. On Linux the sandbox has its own network namespace, loopback
  included, and `dotnet test` runs without either.

## Options considered

1. **A container per run.** Strong isolation, but heavy to set up per product and machine, slow to start, and the
   CLIs' sign-in has to be brought into it.
2. **The sandbox the vendors already ship.** Claude Code's sandbox for agent commands and `srt`, the same runtime as
   a CLI, for the runner's own checks. Light, works on macOS and Linux, and it is what the CLI vendor maintains.
3. **Rely on denied-command lists and prompts.** Cheap, and already in place, but it does not stop a check from
   running code that sends data out.

## Decision

We take option 2, and keep secrets out of the environment whatever the sandbox does.

- Claude Code agents get a `sandbox` block in `--settings`: fail closed, no unsandboxed retries, network only to
  `sandbox.network_allow`, `sandbox.deny_read` hidden, `sandbox.secret_env` removed. The same paths are denied to
  the Read tool.
- The runner's checks run under `srt` with the same rules, and with an environment from which `sandbox.secret_env`
  and every name that looks like a secret are removed. Without `srt` they refuse to run.
- Codex starts with that cleaned environment plus only its own sign-in variables. It has no network in
  `workspace-write`, and the runner's secret scan below is the backstop for what it can read.
- Before any commit, added lines are scanned for credentials (Anthropic, OpenAI, GitHub, Atlassian, Slack, AWS, npm,
  private keys, and the policy's `secret_patterns`). A hit sends the item back with the place and kind, never the
  value, and nothing is committed.
- The only way to run unsandboxed is the operator's `ASF_UNSAFE_NO_SANDBOX=1`. It is read from the runner's own
  environment, never from a product's files, so an agent cannot set it.
- The runner creates `/tmp/claude` and the writable caches before it starts a sandbox, and sets
  `EnableSourceControlManagerQueries=false` for checks and agent commands. `sandbox.local_binding` is off by default;
  a product whose tests need loopback turns it on, and on macOS the runner then also sets
  `DOTNET_SYSTEM_NET_DISABLEIPV6=1`.
- `sandbox.network_allow` is the one policy list a product widens, for the hosts it needs (a chain API for a wallet,
  say). Only the owner can change `.factory/policy.yaml`; agents cannot.

## Consequences

- A host needs `npm install -g @anthropic-ai/sandbox-runtime`, and on Linux `bubblewrap` and `socat`. On Ubuntu
  24.04 AppArmor may block unprivileged user namespaces; see the sandbox-runtime README.
- .NET products run sandboxed on macOS and Linux. On macOS they need `sandbox.local_binding: true`, which lets their
  checks reach services listening on the owner's machine; unattended runs happen on Linux, where it opens nothing.
- Toolchain workarounds live in one place, `toolchainEnv` in `src/sandbox.ts`. A new stack that fails only in the
  sandbox gets its fix there, with the reason, and a reference eval case that shows it.
- Registries on the allowlist are a way out only for something that can publish to them, and publishing commands
  are denied. Package installs still pull third-party code; that is the product's risk, as it is for a person.
- The secret scan only knows the formats it lists. It is a backstop, not the boundary.
