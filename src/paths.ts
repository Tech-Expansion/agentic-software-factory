import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the installed factory: agents/, skills/, workflows/, policies/, templates/, schemas/. */
export const factoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function factoryHome(): string {
  return process.env.ASF_HOME ?? join(homedir(), '.agentic-software-factory');
}

/** Walks up from `start` to the first directory that holds `.factory/project.yaml`. */
export function findProductRoot(start: string = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.factory', 'project.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function productPaths(root: string) {
  const factory = join(root, '.factory');
  return {
    root,
    factory,
    project: join(factory, 'project.yaml'),
    policy: join(factory, 'policy.yaml'),
    memory: join(factory, 'memory'),
    runs: join(factory, 'runs'),
    worktrees: join(factory, 'worktrees'),
    state: join(factory, 'state.json'),
    backlog: join(root, 'backlog'),
  };
}

export type ProductPaths = ReturnType<typeof productPaths>;
