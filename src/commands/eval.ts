import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EngineContext } from '../engine.js';
import { loadCases, runCase, summarize, type CaseResult, type EvalSummary } from '../eval.js';
import { git } from '../git.js';
import { factoryHome, factoryRoot } from '../paths.js';
import { version } from '../version.js';

export interface EvalOptions {
  cases?: string;
  only?: string;
  out?: string;
  keep?: boolean;
  log?: (msg: string) => void;
  /** For tests. */
  context?: Partial<EngineContext>;
}

export interface EvalRun {
  version: string;
  commit?: string;
  at: string;
  summary: EvalSummary;
  cases: CaseResult[];
  file: string;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Runs the eval cases one after another and writes the results as JSON. */
export async function evaluate(opts: EvalOptions = {}): Promise<EvalRun> {
  const log = opts.log ?? (() => {});
  const cases = loadCases(opts.cases ?? join(factoryRoot, 'evals', 'cases'), opts.only);
  const home = factoryHome();
  const at = new Date().toISOString();
  const file = opts.out ?? join(home, 'evals', `${at.replace(/[:.]/g, '-')}.json`);
  // Fixtures register themselves like any product; keep them out of the user's list.
  const saved = process.env.ASF_HOME;
  process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-eval-home-'));
  const results: CaseResult[] = [];
  try {
    for (const c of cases) {
      log(`== ${c.id} (${c.stack})`);
      const r = await runCase(c, { context: opts.context, keep: opts.keep, log: (m) => log(`   ${m}`) });
      results.push(r);
      log(`   ${r.delivered ? 'delivered' : 'NOT delivered'}${r.error ? `: ${r.error}` : ''}${r.root ? ` (kept in ${r.root})` : ''}`);
    }
  } finally {
    if (saved === undefined) delete process.env.ASF_HOME;
    else process.env.ASF_HOME = saved;
  }
  const commit = git(factoryRoot, ['rev-parse', '--short', 'HEAD'], true).trim() || undefined;
  const out: EvalRun = { version, commit, at, summary: summarize(results), cases: results, file };
  mkdirSync(dirname(file), { recursive: true });
  const { file: _f, ...data } = out;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return out;
}

export function formatEval(r: EvalRun): string {
  const s = r.summary;
  const width = Math.max(...r.cases.map((c) => c.id.length), 4);
  const lines = [`asf ${r.version}${r.commit ? ` (${r.commit})` : ''}: ${s.cases} case(s)`, ''];
  for (const c of r.cases) {
    const why = c.error ?? c.breaches[0] ?? c.items.find((i) => i.state !== 'done')?.reason ?? (c.hidden?.ok === false ? 'hidden checks failed' : '');
    const attempts = c.items.map((i) => i.attempts).join('+') || '0';
    lines.push(
      `${c.id.padEnd(width)}  ${(c.delivered ? 'delivered' : 'FAILED').padEnd(9)}  attempts ${attempts.padEnd(5)}  ${fmt(c.tokens).padStart(6)} tokens  ${Math.round(c.durationMs / 1000)}s${why && !c.delivered ? `\n${' '.repeat(width + 2)}${why.split('\n')[0]}` : ''}`,
    );
  }
  lines.push(
    '',
    `delivered ${s.delivered}/${s.cases} (${pct(s.rate)}, 95% interval ${pct(s.interval[0])}-${pct(s.interval[1])}), first attempt ${s.firstAttempt}/${s.cases}`,
    `hard-gate breaches ${s.breaches}${s.errors ? `, errors ${s.errors}` : ''}`,
    `tokens per case: median ${fmt(s.tokensMedian)}, p90 ${fmt(s.tokensP90)}`,
    `results: ${r.file}`,
  );
  return lines.join('\n');
}
