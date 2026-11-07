import type { TrackerConfig } from '../config.js';
import { exec, tail } from '../runtimes/exec.js';
import type { Comment, Ticket, Tracker } from './types.js';

export class TrackerError extends Error {}

export type Runner = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Runs Atlassian's own CLI, signed in by the user (`acli jira auth login --web`). The factory never sees the token. */
export const acli: Runner = (args) => exec('acli', args, { cwd: process.cwd(), input: '', timeoutMs: 60_000 });

/** Plain text from Atlassian Document Format, or the string as it is. */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return n.attrs?.text ?? '';
  const inner = (n.content ?? []).map(adfToText);
  switch (n.type) {
    case 'doc':
      return inner.join('\n\n').trim();
    case 'paragraph':
    case 'heading':
      return inner.join('');
    case 'bulletList':
    case 'orderedList':
      return inner.map((t) => `- ${t}`).join('\n');
    case 'listItem':
      return inner.join('\n');
    case 'codeBlock':
      return `\`\`\`\n${inner.join('')}\n\`\`\``;
    default:
      return inner.join('\n');
  }
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Jira through `acli`. Its JSON output is not documented; fields are read defensively, from the shapes of Jira's REST
 * API that it wraps (`fields.summary`, `fields.status.name`, ...).
 */
export function jira(cfg: TrackerConfig, run: Runner = acli): Tracker {
  const call = async (args: string[]) => {
    const r = await run(args);
    if (r.code !== 0) throw new TrackerError(`acli ${args.slice(0, 3).join(' ')} failed: ${tail(r.stderr || r.stdout, 600)}`);
    return r.stdout;
  };
  const json = async (args: string[]) => {
    const out = await call(args);
    try {
      return JSON.parse(out) as unknown;
    } catch {
      throw new TrackerError(`acli ${args.slice(0, 3).join(' ')} did not return JSON: ${tail(out, 300)}`);
    }
  };
  const list = (v: unknown, ...keys: string[]): unknown[] => {
    if (Array.isArray(v)) return v;
    for (const k of keys) {
      const x = (v as Record<string, unknown> | undefined)?.[k];
      if (Array.isArray(x)) return x;
    }
    return [];
  };
  const ticket = (raw: unknown): Ticket => {
    const r = raw as { key: string; fields?: Record<string, unknown> };
    const f = r.fields ?? {};
    const status = f.status as { name?: string } | string | undefined;
    const reporter = f.reporter as { accountId?: string } | undefined;
    return {
      key: r.key,
      title: String(f.summary ?? ''),
      body: adfToText(f.description),
      status: typeof status === 'string' ? status : (status?.name ?? ''),
      labels: Array.isArray(f.labels) ? (f.labels as string[]) : [],
      reporter: reporter?.accountId,
    };
  };
  return {
    name: 'jira',
    async intake() {
      const extra = cfg.intake_filter ? ` AND (${cfg.intake_filter})` : '';
      const jql = `project = ${quote(cfg.project)} AND reporter = ${quote(cfg.owner)} AND status = ${quote(cfg.intake_status ?? 'To Do')}${extra} ORDER BY created ASC`;
      const found = await json(['jira', 'workitem', 'search', '--jql', jql, '--fields', 'key,summary,status,labels,description,reporter', '--paginate', '--json']);
      // The JQL already asks for the owner's tickets; checked again so a wrong query can never let others in.
      return list(found, 'issues', 'workItems', 'values').map(ticket).filter((t) => !t.reporter || t.reporter === cfg.owner);
    },
    async comments(key) {
      const found = await json(['jira', 'workitem', 'comment', 'list', '--key', key, '--paginate', '--json']);
      return list(found, 'comments', 'values').map((raw) => {
        const c = raw as { id?: string | number; author?: { accountId?: string }; body?: unknown; created?: string };
        return { id: String(c.id ?? ''), author: c.author?.accountId ?? '', body: adfToText(c.body), created: c.created ?? '' } satisfies Comment;
      });
    },
    async comment(key, body) {
      await call(['jira', 'workitem', 'comment', 'create', '--key', key, '--body', body]);
    },
    async transition(key, status) {
      await call(['jira', 'workitem', 'transition', '--key', key, '--status', status, '--yes']);
    },
    async label(key, add, remove) {
      if (add.length) await call(['jira', 'workitem', 'edit', '--key', key, '--labels', add.join(','), '--yes']);
      if (remove.length) await call(['jira', 'workitem', 'edit', '--key', key, '--remove-labels', remove.join(','), '--yes']);
    },
  };
}
