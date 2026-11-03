import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Tokens {
  input: number;
  cached_input: number;
  output: number;
  total: number;
}

export interface RunEvent {
  at: string;
  item: string;
  attempt?: number;
  step: string;
  kind: 'agent' | 'checks' | 'item';
  role?: string;
  runtime?: string;
  model?: string;
  tokens?: Tokens;
  cost_usd?: number;
  duration_ms?: number;
  outcome: string;
  detail?: string;
}

export const day = (iso: string) => iso.slice(0, 10);

/** Appends one event to `<runs>/<date>.jsonl`. The log is append-only. */
export function appendEvent(runsDir: string, event: RunEvent): void {
  mkdirSync(runsDir, { recursive: true });
  appendFileSync(join(runsDir, `${day(event.at)}.jsonl`), JSON.stringify(event) + '\n');
}

export function readEvents(runsDir: string, date?: string): RunEvent[] {
  if (!existsSync(runsDir)) return [];
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith('.jsonl') && (!date || f === `${date}.jsonl`))
    .sort();
  return files.flatMap((f) =>
    readFileSync(join(runsDir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEvent),
  );
}
