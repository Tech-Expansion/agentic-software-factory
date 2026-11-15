# agentic-software-factory

A software team of AI agents that works on your own machine. You say what you want; the team plans it with you,
builds it, tests it and reviews it, using your own Claude Code or Codex subscription.

You are the client. You decide what the product does and when it ships. The team makes the technical calls and
comes back to you only with decisions that are yours.

> Status: 0.1, experimental. Works end to end with Claude Code 2.1 and codex-cli 0.147. Not yet on npm.

## What you need

- [Node.js](https://nodejs.org) 22 or later, and git
- [Claude Code](https://claude.com/claude-code) or Codex, installed and signed in
- macOS, Linux or Windows

## Install

```bash
git clone https://github.com/Tech-Expansion/agentic-software-factory.git
```

```bash
cd agentic-software-factory
```

```bash
npm install && npm run build && npm link
```

`asf --help` now works in any folder.

## Your first product

1. **Create it.**

   ```bash
   asf init my-idea
   ```

   ```bash
   cd my-idea
   ```

2. **Plan it.** `asf discover` opens a conversation with the product owner. It asks about your idea one question at a
   time, then writes the brief, the specs and the list of work. Nothing is built until you agree to it.
3. **Check it.** `asf validate` tells you if anything is missing before the team starts, and how to save the plan
   so the team can see it.
4. **Let the team work.** `asf run --watch` builds the items one after another until you stop it with Ctrl-C.
5. **Decide what is yours.** `asf` shows the board: what the team is doing, and every decision waiting for you with
   the exact command that gives it.

## Everyday commands

| Command | What it does |
| --- | --- |
| `asf` | The board: progress, and what waits for you |
| `asf show <id>` | One item: its questions, its work, why it stopped |
| `asf decide <id> …` | Your decision: `approve`, `reject <reason>`, `retry`, or an answer such as `Q1 web` |
| `asf run --watch` | Keep the team working |
| `asf release` | Ship what the team finished into your main branch |

`asf --help` lists the rest.

## Is it safe?

Each item is built in its own copy of your code and reaches your main branch only when you say so. Changes the team
makes to your plans, specs or settings are undone, and anything that looks like a password or key is never committed.

By default the commands an agent runs have the same access to your machine as you do, like any coding agent you run
yourself. For a product that handles keys, money or personal data, turn on the sandbox:
[how](ARCHITECTURE.md#the-sandbox).

## Go deeper

- [ARCHITECTURE.md](ARCHITECTURE.md): the team, how an item is built, what the runner enforces, settings, platforms
- [docs/roadmap.md](docs/roadmap.md): what works, how it is measured, what is next
- [docs/adr/](docs/adr/): the decisions behind it, and why
- [AGENTS.md](AGENTS.md): working on the factory itself

## License

[MIT](LICENSE)
