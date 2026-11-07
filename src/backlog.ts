import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { validate } from './config.js';
import type { ItemState, State } from './state.js';

export interface BacklogItem {
  id: string;
  title: string;
  /** new: waiting for the analyst or the owner's answers. draft: parked by the owner. Only ready items are built. */
  status: 'new' | 'draft' | 'ready' | 'done';
  priority?: number;
  spec?: string;
  criteria?: string[];
  depends_on?: string[];
  file: string;
  body: string;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseItem(file: string, text: string): { item?: BacklogItem; errors: string[] } {
  const m = FRONT.exec(text);
  if (!m) return { errors: [`${file}: no front matter`] };
  let data: unknown;
  try {
    data = parse(m[1]!);
  } catch (err) {
    return { errors: [`${file}: ${(err as Error).message}`] };
  }
  const errors = validate('backlog-item', data).map((e) => `${file}: ${e}`);
  if (errors.length) return { errors };
  return { item: { ...(data as Omit<BacklogItem, 'file' | 'body'>), file, body: text.slice(m[0].length).trim() }, errors: [] };
}

export function loadBacklog(dir: string): { items: BacklogItem[]; errors: string[] } {
  const items: BacklogItem[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { items, errors };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()) {
    const file = join(dir, name);
    const r = parseItem(file, readFileSync(file, 'utf8'));
    if (r.item) items.push(r.item);
    errors.push(...r.errors);
  }
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) errors.push(`${it.file}: duplicate id ${it.id}`);
    ids.add(it.id);
  }
  return { items, errors };
}

const BUSY: ItemState['state'][] = ['in-progress', 'review', 'blocked'];

/** The next item to build: ready, not busy, every dependency done; lowest priority number first. */
export function nextReady(items: BacklogItem[], state: State): BacklogItem | undefined {
  const done = new Set(items.filter((i) => i.status === 'done').map((i) => i.id));
  return items
    .filter((i) => i.status === 'ready')
    .filter((i) => !BUSY.includes(state.items[i.id]?.state as ItemState['state']))
    .filter((i) => (i.depends_on ?? []).every((d) => done.has(d)))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.id.localeCompare(b.id))[0];
}

/** Rewrites the `status:` line of an item's front matter in place, leaving the rest of the file as it is. */
export function setStatus(file: string, status: BacklogItem['status']): void {
  const text = readFileSync(file, 'utf8');
  const m = FRONT.exec(text);
  if (!m) throw new Error(`${file}: no front matter`);
  const front = m[0].replace(/^status:.*$/m, `status: ${status}`);
  writeFileSync(file, front + text.slice(m[0].length));
}

export function relativeFile(root: string, item: BacklogItem): string {
  return relative(root, item.file);
}
