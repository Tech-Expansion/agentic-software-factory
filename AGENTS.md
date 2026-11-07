# Working on agentic-software-factory

For any agent or person changing this repository. What the product is and why: [README](README.md) and
[docs/adr/](docs/adr/).

## Commands

- Install: `npm install`
- Build: `npm run build` (TypeScript to `dist/`)
- Test: `npm test` (builds, then `node --test`; uses a fake runtime, spends no tokens)
- Try it: `node dist/cli.js <command>`, or `npm link` for `asf`
- Check the eval cases: `node dist/cli.js eval --reference` (no tokens)
- Measure the factory: `node dist/cli.js eval` (spends tokens on your CLI)

## Rules

- The runner never imports a vendor SDK and never reads, stores or forwards credentials ([ADR 0001](docs/adr/0001-run-inside-the-users-own-agent-cli.md)).
  It only starts the official CLIs as subprocesses.
- Never pass `--bare` to Claude Code: it ignores the subscription sign-in.
- Policy is enforced in code (`src/engine.ts`), not in prompts. A rule that matters gets a check and a test.
- Everything in `agents/` and `skills/` is sent with every step that uses it. Keep it short; each line costs tokens on
  every call.
- A change to a CLI flag or output shape in `src/runtimes/` is checked against the real CLI before it lands, and the
  versions in ADR 0003 are updated.
- Dependencies stay at `yaml` and `ajv` unless an ADR says otherwise.
- Code, comments, commits and docs are in English. Commits follow Conventional Commits.
- A decision that is hard to undo gets an ADR in `docs/adr/`.
- A change to `agents/`, `skills/`, `workflows/` or the engine that is meant to make the factory better says so with
  `asf eval --trials 3` numbers from before and after. New eval cases come with a `reference/` solution that passes
  `asf eval --reference`, and hidden tests that fail on the untouched fixture. A capability case that the factory
  passes in every trial for two versions in a row moves to `regression`.
