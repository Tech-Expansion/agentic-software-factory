#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { ConfigError } from './config.js';
import { GitError } from './git.js';
import { factoryHome } from './paths.js';
import { version } from './version.js';
import { openProduct, UsageError } from './commands/context.js';
import { board, formatBoard } from './status.js';
import { discover } from './commands/discover.js';
import { answer, clarify, questions, type ClarifyOutcome } from './commands/clarify.js';
import { evaluate, formatEval } from './commands/eval.js';
import { serve } from './commands/serve.js';
import { sync } from './commands/sync.js';
import { init } from './commands/init.js';
import { report } from './commands/report.js';
import { approve, describe, reject, release, releasable, retry } from './commands/review.js';
import { run } from './commands/run.js';
import { validateProduct } from './commands/validate.js';

const HELP = `asf ${version}: agentic software factory

Usage:
  asf init [dir] [--name <name>]    create a product skeleton and register it
  asf discover                      plan with the planner: brief, specs, backlog
  asf validate                      check settings, policy, backlog and spec links
  asf clarify [--item <id>] [--again]
                                    the analyst reads new items and asks what it needs to know
  asf questions                     open questions, with options and the team's recommendation
  asf answer <id> <Q> <answer>      answer one question; with --accept instead of <Q> <answer>,
                                    take the recommendation for every question left
  asf sync                          with a tracker: take in new tickets, post questions and
                                    results, apply the owner's answers and decisions
  asf run [--item <id>] [--all]     build the next ready item (or one, or all)
  asf serve [--workers <n>] [--interval <s>] [--once]
                                    work unattended: intake, questions, builds, n at a time;
                                    Ctrl-C stops after the items in progress
  asf status [--json]               the board: what each item is doing, what the team is doing,
                                    and every decision waiting for you, oldest first
  asf show <id>                     where an item's work is and why it stopped
  asf approve <id>                  approve a plan, or merge an item in review (into the
                                    integration branch when there is one)
  asf release [--dry]               merge the integration branch into the base branch
  asf reject <id> <reason>          send an item in review back with feedback
  asf retry <id>                    let a blocked item run again
  asf report [--date YYYY-MM-DD]    daily report
  asf projects                      products registered on this machine
  asf eval [--case <id>] [--suite regression|capability] [--trials <k>]
           [--cases <dir>] [--out <file>] [--keep] [--reference]
                                    build the eval cases and score them against hidden tests,
                                    k times each for pass^k; --reference checks the cases with
                                    their own solutions
`;

function clarified(o: ClarifyOutcome): string {
  if (o.ready) return `${o.id} is ready to build`;
  if (o.open) return `${o.id}: ${o.open} blocking question(s) open; see \`asf questions\``;
  return `${o.id}: clear, but not made ready: ${o.note}`;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      item: { type: 'string' },
      all: { type: 'boolean' },
      date: { type: 'string' },
      case: { type: 'string' },
      cases: { type: 'string' },
      suite: { type: 'string' },
      trials: { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'boolean' },
      reference: { type: 'boolean' },
      again: { type: 'boolean' },
      dry: { type: 'boolean' },
      workers: { type: 'string' },
      interval: { type: 'string' },
      once: { type: 'boolean' },
      accept: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.version) return console.log(version), 0;
  if (values.help || !cmd || cmd === 'help') return console.log(HELP), 0;
  const need = (i: number, what: string) => {
    const v = args[i];
    if (!v) throw new UsageError(`missing ${what}`);
    return v;
  };

  switch (cmd) {
    case 'init': {
      const r = init(args[0] ?? '.', values.name);
      for (const f of r.created) console.log(`created ${f}`);
      for (const f of r.skipped) console.log(`kept    ${f}`);
      console.log('\nNext: fill in .factory/project.yaml (commands.check above all), then run `asf discover`.');
      return 0;
    }
    case 'discover':
      return discover();
    case 'validate': {
      const r = validateProduct();
      for (const w of r.warnings) console.log(`warning: ${w}`);
      for (const e of r.errors) console.error(`error: ${e}`);
      if (!r.errors.length) console.log('ok');
      return r.errors.length ? 1 : 0;
    }
    case 'run': {
      const outcomes = await run({ item: values.item, all: values.all, log: (m) => console.log(m) });
      if (!outcomes.length) console.log('nothing is ready');
      return outcomes.some((o) => o.state === 'blocked') ? 2 : 0;
    }
    case 'status': {
      const b = board(openProduct());
      console.log(values.json ? JSON.stringify(b, null, 2) : formatBoard(b));
      return 0;
    }
    case 'show':
      console.log(describe(need(0, 'item id')));
      return 0;
    case 'approve': {
      const r = approve(need(0, 'item id'));
      console.log(r.into === 'plan' ? 'plan approved; it is built on the next `asf run`' : `merged ${r.merged} into ${r.into}`);
      return 0;
    }
    case 'reject':
      reject(need(0, 'item id'), args.slice(1).join(' '));
      console.log('sent back; it runs again on the next `asf run`');
      return 0;
    case 'clarify': {
      const out = await clarify({ item: values.item, again: values.again, log: (m) => console.log(m) });
      if (!out.length) console.log('no new items');
      for (const o of out) console.log(clarified(o));
      return 0;
    }
    case 'serve': {
      const stop = new AbortController();
      process.once('SIGINT', () => {
        console.log('stopping after the items in progress; Ctrl-C again to quit now (they resume on the next start)');
        stop.abort();
        process.once('SIGINT', () => process.exit(130));
      });
      process.once('SIGTERM', () => stop.abort());
      const r = await serve({
        workers: values.workers ? Number(values.workers) : undefined,
        intervalSeconds: values.interval ? Number(values.interval) : undefined,
        rounds: values.once ? 1 : undefined,
        signal: stop.signal,
        log: (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`),
      });
      console.log(`stopped after ${r.rounds} round(s), ${r.outcomes.length} item(s) finished`);
      return 0;
    }
    case 'sync': {
      const out = await sync({ log: (m) => console.log(m) });
      if (!out.length) console.log('nothing to sync');
      return 0;
    }
    case 'questions':
      console.log(questions());
      return 0;
    case 'answer': {
      const id = need(0, 'item id');
      const o = values.accept ? answer(id, undefined, '', { accept: true }) : answer(id, need(1, 'question id (Q1, ...)'), args.slice(2).join(' '));
      console.log(clarified(o));
      return 0;
    }
    case 'release': {
      if (values.dry) {
        const ids = releasable();
        console.log(ids.length ? `would release: ${ids.join(', ')}` : 'nothing to release');
        return 0;
      }
      const r = release();
      console.log(r.items.length ? `released ${r.items.join(', ')} (${r.commit})` : 'nothing to release');
      return 0;
    }
    case 'retry':
      retry(need(0, 'item id'));
      console.log('it runs again on the next `asf run`');
      return 0;
    case 'report':
      console.log(report(values.date));
      return 0;
    case 'projects': {
      const file = join(factoryHome(), 'projects.yaml');
      const list = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) as { name: string; path: string }[] | null) ?? []) : [];
      for (const p of list) console.log(`${p.name}\t${p.path}`);
      return 0;
    }
    case 'eval': {
      const r = await evaluate({
        cases: values.cases,
        only: values.case,
        suite: values.suite,
        trials: values.trials === undefined ? undefined : Number(values.trials),
        out: values.out,
        keep: values.keep,
        reference: values.reference,
        log: (m) => console.log(m),
      });
      console.log(`\n${formatEval(r)}`);
      return r.summary.breaches || r.summary.errors ? 2 : 0;
    }
    default:
      throw new UsageError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || err instanceof ConfigError || err instanceof GitError) {
      console.error(`asf: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  },
);
