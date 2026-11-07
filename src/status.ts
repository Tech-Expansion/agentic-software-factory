import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklog, type BacklogItem } from './backlog.js';
import { loadClarification, openQuestions } from './clarify.js';
import type { Product } from './commands/context.js';
import { alive } from './lock.js';
import { day, readEvents } from './runlog.js';
import { loadLessons } from './retro.js';
import { loadState, type ItemState } from './state.js';

/** What `asf serve` writes each round, so anyone can see what the team is doing without asking it. */
export interface Heartbeat {
  pid: number;
  started: string;
  workers: number;
  round: number;
  at: string;
  running: string[];
  paused_until?: string;
}

const beatFile = (factory: string) => join(factory, 'serve.json');
export const writeHeartbeat = (factory: string, h: Heartbeat) => writeFileSync(beatFile(factory), JSON.stringify(h, null, 2) + '\n');
export const clearHeartbeat = (factory: string) => rmSync(beatFile(factory), { force: true });

export function readHeartbeat(factory: string): Heartbeat | undefined {
  const file = beatFile(factory);
  if (!existsSync(file)) return undefined;
  const h = JSON.parse(readFileSync(file, 'utf8')) as Heartbeat;
  return alive(h.pid) ? h : undefined;
}

/** Something only the owner can do. The queue is oldest first: the longer a decision waits, the longer the team does. */
export interface Decision {
  item: string;
  title: string;
  kind: 'answer' | 'plan' | 'review' | 'blocked' | 'release' | 'lesson';
  since: string;
  what: string;
  /** How to give it: a command here, or a reply on the ticket. */
  how: string;
  ticket?: string;
}

export type Column = 'asking' | 'new' | 'ready' | 'waiting' | 'building' | 'plan' | 'review' | 'blocked' | 'merged' | 'done' | 'draft';

export interface Board {
  product: string;
  team?: Heartbeat;
  columns: Partial<Record<Column, string[]>>;
  decisions: Decision[];
  tokens: { today: number; week: number };
}

function column(item: BacklogItem, st: ItemState | undefined, factory: string, ready: Set<string>): Column {
  if (item.status === 'done') return 'done';
  if (item.status === 'draft') return 'draft';
  if (item.status === 'new') {
    const c = loadClarification(factory, item.id);
    return c && openQuestions(c).length ? 'asking' : 'new';
  }
  if (!st) return ready.has(item.id) ? 'ready' : 'waiting';
  if (st.state === 'in-progress' || st.state === 'rework') return 'building';
  if (st.state === 'plan-review') return 'plan';
  return st.state;
}

/** The whole product at a glance: what each item is doing, what waits for the owner, and what the team spent. */
export function board(product: Product, now: Date = new Date()): Board {
  const { paths, project } = product;
  const { items } = loadBacklog(paths.backlog);
  const state = loadState(paths.state);
  const done = new Set(items.filter((i) => i.status === 'done' || state.items[i.id]?.state === 'merged').map((i) => i.id));
  const ready = new Set(items.filter((i) => (i.depends_on ?? []).every((d) => done.has(d))).map((i) => i.id));
  const columns: Board['columns'] = {};
  for (const item of items) (columns[column(item, state.items[item.id], paths.factory, ready)] ??= []).push(item.id);

  const tracker = !!project.tracker;
  const reply = (ticket: string | undefined, text: string, command: string) => (tracker && ticket ? `reply on ${ticket}: ${text}` : command);
  const decisions: Decision[] = [];
  for (const item of items) {
    const st = state.items[item.id];
    const base = { item: item.id, title: item.title, ticket: item.tracker };
    if (item.status === 'new') {
      const c = loadClarification(paths.factory, item.id);
      const open = c ? openQuestions(c) : [];
      if (c && open.length)
        decisions.push({ ...base, kind: 'answer', since: c.at, what: `${open.length} question(s): ${open.map((q) => q.id).join(', ')}`, how: reply(item.tracker, '"Q1: <answer>" or "/accept"', `asf questions, then asf answer ${item.id} <Q> <answer>`) });
      continue;
    }
    if (!st) continue;
    if (st.state === 'plan-review')
      decisions.push({ ...base, kind: 'plan', since: st.updated_at, what: 'approve the plan of a high-risk item', how: reply(item.tracker, '"/approve" or "/reject <reason>"', `asf show ${item.id}, then asf approve ${item.id}`) });
    else if (st.state === 'review')
      decisions.push({ ...base, kind: 'review', since: st.updated_at, what: st.flags?.length ? `review the change; it touches ${st.flags.join(', ')}` : 'review the change', how: reply(item.tracker, '"/approve" or "/reject <reason>"', `git diff ${project.integration_branch ?? project.base_branch ?? 'main'}...${st.branch}, then asf approve ${item.id}`) });
    else if (st.state === 'blocked')
      decisions.push({ ...base, kind: 'blocked', since: st.updated_at, what: st.reason ?? 'blocked', how: reply(item.tracker, '"/retry"', `asf retry ${item.id}`) });
  }
  const merged = Object.entries(state.items).filter(([, v]) => v.state === 'merged');
  if (merged.length) {
    const since = merged.map(([, v]) => v.updated_at).sort()[0]!;
    decisions.push({ item: merged.map(([id]) => id).sort().join(', '), title: `${merged.length} item(s) in ${project.integration_branch}`, kind: 'release', since, what: `release into ${project.base_branch ?? 'main'}`, how: 'asf release' });
  }
  const digest = project.tracker?.digest;
  for (const l of loadLessons(paths.factory).filter((x) => x.status === 'proposed')) {
    const seen = l.items.length > 1 ? `, seen on ${l.items.join(', ')}` : '';
    decisions.push({
      item: l.id,
      title: l.title,
      kind: 'lesson',
      since: l.at,
      what: `a ${l.scope} ${l.kind}${seen}${l.note ? `; ${l.note}` : ''}: ${l.proposal}`,
      how: digest ? `reply on ${digest}: "/lesson ${l.id} accept" or "/lesson ${l.id} reject"` : `asf lesson ${l.id} accept, or reject`,
    });
  }
  decisions.sort((a, b) => a.since.localeCompare(b.since));

  const agentTokens = (date?: string) => readEvents(paths.runs, date).filter((e) => e.kind === 'agent').reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
  let week = 0;
  for (let d = 0; d < 7; d++) week += agentTokens(day(new Date(now.getTime() - d * 86_400_000).toISOString()));
  return { product: project.name, team: readHeartbeat(paths.factory), columns, decisions, tokens: { today: agentTokens(day(now.toISOString())), week } };
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

const ago = (iso: string, now: Date) => {
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

const ORDER: Column[] = ['asking', 'new', 'ready', 'waiting', 'building', 'plan', 'review', 'blocked', 'merged', 'done', 'draft'];

export function formatBoard(b: Board, now: Date = new Date()): string {
  const out = [`# ${b.product}`, ''];
  if (b.team) {
    const paused = b.team.paused_until && new Date(b.team.paused_until) > now ? `, paused by a usage limit until ${b.team.paused_until}` : '';
    const busy = b.team.running.length ? `building ${b.team.running.join(', ')}` : 'idle';
    out.push(`Team: asf serve (pid ${b.team.pid}), ${busy} (${b.team.running.length}/${b.team.workers}), last round ${ago(b.team.at, now)} ago${paused}`);
  } else {
    out.push('Team: not running; `asf serve` starts it');
  }
  out.push('', ...ORDER.filter((c) => b.columns[c]?.length).map((c) => `${c.padEnd(9)} ${b.columns[c]!.join(' ')}`), '');
  out.push(`## Waiting for you (${b.decisions.length})`, '');
  if (!b.decisions.length) out.push('- nothing');
  for (const d of b.decisions) out.push(`- ${d.item} ${d.title} [${d.kind}, ${ago(d.since, now)}]: ${d.what}`, `  ${d.how}`);
  out.push('', `Tokens: ${fmtTokens(b.tokens.today)} today, ${fmtTokens(b.tokens.week)} in the last 7 days`);
  return out.join('\n');
}
