import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export class GitError extends Error {}

export function git(cwd: string, args: string[], allowFail = false, input?: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new GitError(`git ${args.join(' ')} failed in ${cwd}:\n${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

export const isRepo = (cwd: string) => spawnSync('git', ['rev-parse', '--git-dir'], { cwd }).status === 0;
export const currentBranch = (cwd: string) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

/** True when tracked files have no changes. Untracked files do not count. */
export const isClean = (cwd: string) => git(cwd, ['status', '--porcelain', '--untracked-files=no']).trim() === '';

export function ensureWorktree(root: string, path: string, branch: string, base: string): void {
  if (existsSync(path)) return;
  const exists = git(root, ['branch', '--list', branch]).trim() !== '';
  git(root, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base]);
}

export function removeWorktree(root: string, path: string, branch: string): void {
  if (existsSync(path)) git(root, ['worktree', 'remove', '--force', path]);
  git(root, ['branch', '-D', branch], true);
}

/** Stages everything in the worktree and lists the files that differ from `base`. */
export function stageAndList(worktree: string, base: string): string[] {
  git(worktree, ['add', '-A']);
  return git(worktree, ['diff', '--cached', '--name-only', base]).split('\n').filter(Boolean);
}

export function stagedDiff(worktree: string, base: string, maxChars: number): string {
  const stat = git(worktree, ['diff', '--cached', '--stat', base]);
  const patch = git(worktree, ['diff', '--cached', base]);
  const cut = patch.length > maxChars ? `${patch.slice(0, maxChars)}\n[diff cut at ${maxChars} characters]` : patch;
  return `${stat}\n${cut}`;
}

/** Puts the given paths back as they are on `base`, deleting them if `base` does not have them. */
export function restorePaths(worktree: string, base: string, paths: string[]): void {
  for (const p of paths) {
    const onBase = spawnSync('git', ['cat-file', '-e', `${base}:${p}`], { cwd: worktree }).status === 0;
    if (onBase) {
      git(worktree, ['checkout', base, '--', p]);
    } else {
      git(worktree, ['rm', '-q', '--cached', '--force', '--ignore-unmatch', p], true);
      rmSync(join(worktree, p), { force: true });
    }
  }
}

export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A']);
  if (git(cwd, ['diff', '--cached', '--name-only']).trim() === '') return false;
  git(cwd, ['commit', '-q', '-F', '-'], false, message);
  return true;
}
