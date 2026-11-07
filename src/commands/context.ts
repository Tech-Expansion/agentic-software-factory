import { loadPolicy, loadProject, type Policy, type ProjectConfig, type RuntimeName } from '../config.js';
import { findProductRoot, productPaths, type ProductPaths } from '../paths.js';
import { claudeCode } from '../runtimes/claude.js';
import { codex } from '../runtimes/codex.js';
import type { Runtime } from '../runtimes/types.js';

export class UsageError extends Error {}

export interface Product {
  paths: ProductPaths;
  project: ProjectConfig;
  policy: Policy;
}

export function openProduct(cwd: string = process.cwd()): Product {
  const root = findProductRoot(cwd);
  if (!root) throw new UsageError('no .factory/project.yaml here or above; run `asf init` first');
  const paths = productPaths(root);
  return { paths, project: loadProject(paths), policy: loadPolicy(paths) };
}

export const runtimes: Record<RuntimeName, Runtime> = { 'claude-code': claudeCode, codex };
