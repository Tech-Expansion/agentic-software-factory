# Agentic Software Factory (ASF)

**Describe the app you want. A small team of AI agents builds it, tests it, and asks you only the decisions that are
yours to make.**

> Status: 0.1, experimental. It works end to end, but it is new: expect rough edges, and keep an eye on what it
> builds. Not yet on npm.

Think of it as hiring a small software agency, except the agency is a team of AI agents that works on your own
computer, with the AI subscription you already have.

- **You are the owner.** You explain what you want, answer questions about it, and decide when it goes live.
- **The team does the rest.** It plans the work, writes the code and the tests, reviews itself, and fixes what fails.
- **You see it grow.** Every finished piece lands in a test version on its own; the real one changes only when you
  release.

## Before you start

- A Mac, Linux or Windows computer
- A **Claude** subscription (Pro or Max), or a **ChatGPT** subscription that includes Codex
- [Node.js](https://nodejs.org) 22 or later, git, and [Claude Code](https://claude.com/claude-code) or Codex,
  installed and signed in. If that line means nothing to you, ask someone technical for 15 minutes, once.

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

## Getting started

Open a terminal and type the commands below. Each one prints what it did and what to do next.

**1. Create a project** (`my-idea` is any name you like):

```bash
asf init my-idea
```

```bash
cd my-idea
```

**2. Talk the idea through.** This opens a conversation with the product owner agent who researches market automatically. Answer in your own words; when you
are not sure, say "decide for me".

```bash
asf discover
```

**3. Check the plan.** It tells you if anything is missing, and how to save the plan so the team can see it.

```bash
asf validate
```

**4. Let the team work.** Leave this window open. Press Ctrl-C to stop it; it picks up where it was next time.

```bash
asf run --watch
```

**5. Check in, any time, in a second window.** The board shows what each piece of work is doing and, under
"Waiting for you", every decision the team needs, with the exact command that gives it.

```bash
asf
```

**6. Go live** when you are happy with what is on the test version:

```bash
asf release
```

## Is it safe?

Each piece is built in its own copy of your code, and only you put a release live. By default the commands an agent
runs can reach what you can reach on your computer, like any coding agent you run yourself. For a product with keys,
money or personal data, turn on the sandbox: [how](ARCHITECTURE.md#the-sandbox).

## Learn more

- [The owner's guide](docs/owners-guide.md): the team, an example from idea to release, giving decisions, questions
  people ask, the words you will see
- [ARCHITECTURE.md](ARCHITECTURE.md): how it works inside, every command and setting, platforms, known limits
- [docs/roadmap.md](docs/roadmap.md): what works, how it is measured, what is next
- [docs/adr/](docs/adr/): the decisions behind it, and why
- [AGENTS.md](AGENTS.md): working on the factory itself

## License

[MIT](LICENSE)
