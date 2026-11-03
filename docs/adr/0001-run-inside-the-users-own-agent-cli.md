# 0001. The factory runs locally, inside the user's own agent CLI

Status: accepted
Date: 2026-11-03
Deciders: project owner

## Context

The factory is a team of agents (planning, building, verifying, operating) that turns a rough idea into tested,
documented software and keeps developing it if it succeeds. It is a long-term open-source product, not a personal
script. Most of the cost of running it is model usage, so where that usage comes from decides the architecture.

Facts checked in November 2026:

- The Claude Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer
  claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Products built on
  the SDK are governed by Anthropic's Commercial Terms and are expected to use API keys.
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview))
- Claude Code documents headless use by the user (`claude -p`, `--output-format json`) as a supported way to drive its
  agent loop from scripts.
- Codex supports sign-in with a ChatGPT plan or with an API key, and recommends API keys for automation such as CI.
  It does not forbid scripted use of a ChatGPT sign-in, and asks that `~/.codex/auth.json` be treated as a password.
  ([Codex authentication](https://learn.chatgpt.com/docs/auth))
- Subscriptions have usage windows and weekly limits. When a user runs out, upgrading the plan is the user's choice.

## Options considered

1. **Hosted service on our own credentials.** Easiest for users. It resells or shares subscription limits, which the
   terms do not allow, and every run becomes our cost.
2. **Our own harness on the Agent SDK, signed in with the user's claude.ai account.** Full control over the agent
   loop. The SDK docs rule out claude.ai login for third-party products unless Anthropic approves it.
3. **Our own harness on the Agent SDK or the APIs, with the user's API key.** Clearly within the terms. Users pay per
   token on top of any plan they already have, which puts off the developers we build for first.
4. **A kit that runs inside the official CLIs the user has installed and signed in to.** The factory ships agents,
   skills, workflow, policies and a local runner that calls `claude -p` or `codex exec`. The user's subscription is
   used by the vendor's own tool, as it is when they run it by hand. The risk: the terms do not say in so many words
   whether a third-party runner calling the user's CLI counts as offering rate limits.

## Decision

We take option 4, as the permanent model, not a stopgap.

- The factory runs on the user's machine or on a host the user controls. There is no hosted execution on our
  credentials.
- Models are reached only through the official CLIs (Claude Code, Codex), signed in by the user through the vendor's
  own flow. The factory never asks for, reads, copies, stores or forwards a token or credential file.
- We do not ship or support proxies or routers that reuse subscription sign-ins outside the vendor's own tool.
- A user who prefers usage billing can sign the same CLIs in with an API key. The factory does not care which.
- Running out of quota is the user's concern. Ours is not wasting it: tokens per accepted unit of work is a design
  metric, and every agent step records what it used.
- Calls to a CLI go through one runtime adapter, so the factory does not depend on a single vendor's flags.

## Consequences

- No cost per user for us, and nothing for us to bill.
- The audience is people who can install and sign in to a CLI: developers first. Non-developers come later, if ever,
  and would need their own decision.
- We are bound to what the CLIs expose. A flag or output format change breaks the adapter, so the adapter is tested
  against each supported CLI version.
- The terms risk in option 4 stays open. Before we promote the project widely we ask Anthropic and OpenAI whether a
  runner like ours is acceptable, and record the answer here. If the answer is no, option 3 (API keys) is the fallback,
  and the runtime adapter is what keeps that switch small.
- Branding must not suggest the factory is Claude Code or any vendor's product.
- Users' plans differ, so the factory must degrade cleanly: pause, report and resume when a limit is reached, and never
  retry in a loop.
