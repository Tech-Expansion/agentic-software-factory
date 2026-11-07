import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** Tool calls the CLI refused in this step. */
  denied?: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a timestamp: a report for "today" means the user's today. */
export const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Appends one event to `<runs>/<date>.jsonl`. The log is append-only. */
export function appendEvent(runsDir: string, event: RunEvent): void {
  mkdirSync(runsDir, { recursive: true });
  appendFileSync(join(runsDir, `${day(event.at)}.jsonl`), JSON.stringify(event) + '\n');
}

/** Keeps what the agent CLI printed for one step: `<runs>/transcripts/<item>/<name>.jsonl`. */
export function saveTranscript(runsDir: string, item: string, name: string, text: string): void {
  const dir = join(runsDir, 'transcripts', item);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), text);
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
