import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Local run state, ignored by git. Backlog files hold only draft, ready and done;
 * everything that happens in between lives here.
 */
export interface ItemState {
  state: 'in-progress' | 'review' | 'blocked' | 'rework';
  branch: string;
  worktree: string;
  attempts: number;
  tokens: number;
  reason?: string;
  feedback?: string;
  flags?: string[];
  summary?: string;
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
