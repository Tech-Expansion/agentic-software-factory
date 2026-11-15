import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Local run state, ignored by git. Backlog files hold only new, draft, ready and done;
 * everything that happens in between lives here.
 */
export interface ItemState {
  /** plan-review: a high-risk item's plan waits for the owner. merged: in the base branch, not in production yet. */
  state: 'in-progress' | 'review' | 'blocked' | 'rework' | 'plan-review' | 'merged';
  branch: string;
  worktree: string;
  attempts: number;
  tokens: number;
  reason?: string;
  feedback?: string;
  flags?: string[];
  summary?: string;
  /** A high-risk item's plan, and when it was approved: by the tech lead, or by the owner when it needed them. */
  plan?: { text: string; approved?: string; by?: 'tech-lead' | 'owner' };
  /** The commit with the item's acceptance tests, and the files in it, which later steps cannot change. */
  tests?: { commit: string; files: string[] };
  /** How far up an item that ran out of attempts went: the tech lead planned it again, the product owner, the owner. */
  escalated?: 'tech-lead' | 'product-owner' | 'owner';
  /** The merge commit on the base branch, once merged: the item is released when production contains it. */
  commit?: string;
  updated_at: string;
}

export interface State {
  items: Record<string, ItemState>;
}

export function loadState(file: string): State {
  if (!existsSync(file)) return { items: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as State;
}

export function saveState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}
