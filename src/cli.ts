#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { ConfigError } from './config.js';
import { GitError } from './git.js';
import { factoryHome } from './paths.js';
import { version } from './version.js';
import { UsageError } from './commands/context.js';
import { discover } from './commands/discover.js';
import { evaluate, formatEval } from './commands/eval.js';
import { init } from './commands/init.js';
import { report } from './commands/report.js';
import { approve, describe, reject, retry } from './commands/review.js';
import { run } from './commands/run.js';
import { validateProduct } from './commands/validate.js';

const HELP = `asf ${version}: agentic software factory

Usage:
  asf init [dir] [--name <name>]    create a product skeleton and register it
  asf discover                      plan with the planner: brief, specs, backlog
  asf validate                      check settings, policy, backlog and spec links
  asf run [--item <id>] [--all]     build the next ready item (or one, or all)
  asf show <id>                     where an item's work is and why it stopped
  asf approve <id>                  merge an item in review into the base branch
  asf reject <id> <reason>          send an item in review back with feedback
  asf retry <id>                    let a blocked item run again
  asf report [--date YYYY-MM-DD]    daily report
  asf projects                      products registered on this machine
  asf eval [--case <id>] [--cases <dir>] [--out <file>] [--keep]
                                    build the eval cases and score them against hidden tests
`;

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
      out: { type: 'string' },
      keep: { type: 'boolean' },
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
    case 'show':
      console.log(describe(need(0, 'item id')));
      return 0;
    case 'approve': {
      const r = approve(need(0, 'item id'));
      console.log(`merged ${r.merged}`);
      return 0;
    }
    case 'reject':
      reject(need(0, 'item id'), args.slice(1).join(' '));
      console.log('sent back; it runs again on the next `asf run`');
      return 0;
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
      const r = await evaluate({ cases: values.cases, only: values.case, out: values.out, keep: values.keep, log: (m) => console.log(m) });
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
