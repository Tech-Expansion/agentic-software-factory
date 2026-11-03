# 0003. A Node.js runner that drives the CLIs as subprocesses

Status: accepted
Date: 2026-11-03
Deciders: project owner

## Context

[0001](0001-run-inside-the-users-own-agent-cli.md) says models are reached only through the official CLIs, signed
in by the user. [0002](0002-repository-layout.md) says roles and skills stay in the factory and the runner hands each
step only what it needs. The runner is what users install. It reads `.factory/`, picks work, calls a CLI, enforces the
policy and records what each step used.

Facts checked on 2026-11-03 with Claude Code 2.1.316 and codex-cli 0.147.0:

- `claude -p --output-format json` returns one JSON object with `result`, `is_error`, `usage`, `total_cost_usd` and
  `session_id`. With `--json-schema` it also returns `structured_output`. It runs on the user's subscription sign-in.
- `--bare` reads only `ANTHROPIC_API_KEY` and never the subscription sign-in, so the runner must not use it.
- The same trivial call cost 39.5k input tokens by default, and 29.4k with `--strict-mcp-config --setting-sources
  project`, which skip the user's MCP servers and user-level settings.
- `codex exec --json` prints JSONL events. Usage is in `turn.completed`, and `--output-schema` constrains the final
  message, which `-o` writes to a file. `-s read-only | workspace-write` picks the sandbox. With stdin left open it
  waits for input, so stdin must be closed.
- Both CLIs are commonly installed with npm or need Node.js on the machine. Our first users are developers.

## Options considered

1. **TypeScript on Node.js, published to npm.** The users we target already have Node.js, the YAML and JSON Schema
   libraries are mature, and the owner works in TypeScript. A Node version must be supported.
2. **.NET global tool.** The owner's main stack, but few of the target users have the .NET SDK installed.
3. **A single binary (Go or Rust).** The easiest install, but a new language for the owner, and nothing it needs is
   missing from Node.js.

## Decision

We take option 1.

- The package is `agentic-software-factory` on npm, and the command is `asf`. It runs on Node.js 22 or later.
- Dependencies are kept to `yaml` and `ajv`. Tests use `node:test`.
- The runner starts the CLIs as subprocesses. It never imports a vendor SDK and never touches credentials.
- For each step the runner builds one prompt from the step's role, the skills the step names, and the artifacts it
  needs: the backlog item, its spec and acceptance criteria, project memory, and the output of failed checks. For
  Claude Code the role and skills go in `--append-system-prompt`. Codex has no such flag, so they open the prompt.
- Claude Code is called with `-p --output-format json --no-session-persistence --strict-mcp-config --setting-sources
  project`. Codex is called with `exec --json --ephemeral` and stdin closed.
- Steps that return a verdict or a plan use a JSON Schema (`--json-schema` or `--output-schema`). The runner
  validates the result again before it trusts it.
- Each backlog item runs in its own git worktree, `.factory/worktrees/<item>`, on branch `asf/<item>`. The runner
  commits there. Only the user's `asf approve <item>` merges it.
- Cheap checks (the product's lint, build and test commands) run before any review by a model. A failure goes back to
  the builder with the check's output, up to the policy's attempt limit, and then the item is blocked.
- Builders get write access to their worktree only: `acceptEdits` and the policy's allowed commands in Claude Code,
  `workspace-write` in Codex. Verifiers are read-only.
- Every step appends one event to `.factory/runs/<date>.jsonl`: item, step, role, runtime, model, tokens, cost when
  known, duration, outcome.
- The factory home is `~/.agentic-software-factory/`, or `ASF_HOME` if set. It holds the list of registered products.

## Consequences

- Install is `npm install -g agentic-software-factory`, next to CLIs the user already has.
- The runner depends on CLI flags and output shapes. The adapters parse defensively, and the facts above are
  re-checked whenever a supported CLI version changes.
- Skipping user-level settings saves about 10k tokens a call, but a user's own Claude Code permissions and hooks do not
  apply to factory runs. The factory policy has to stand on its own.
- There is no container isolation in the first version, so a builder can reach anything its CLI's sandbox allows.
  Running untrusted ideas needs a container or VM, which is a later decision.
- The checks a product runs come from `project.yaml`. A product with weak tests gets weak gates, and the verifier
  report has to say so.
