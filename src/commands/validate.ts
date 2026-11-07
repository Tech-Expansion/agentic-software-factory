import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklog } from '../backlog.js';
import { ConfigError, loadPolicy, loadProject } from '../config.js';
import { findProductRoot, productPaths } from '../paths.js';
import { version } from '../version.js';
import { UsageError } from './context.js';

/** Checks settings, policy and backlog, and that every spec and criterion a backlog item names exists. */
export function validateProduct(cwd: string = process.cwd()): { errors: string[]; warnings: string[] } {
  const root = findProductRoot(cwd);
  if (!root) throw new UsageError('no .factory/project.yaml here or above');
  const paths = productPaths(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const project = loadProject(paths);
    if (project.factory_version !== version) {
      warnings.push(`project.yaml pins factory ${project.factory_version}, this is ${version}`);
    }
    if (!project.commands.check.length) warnings.push('commands.check is empty: nothing but a model checks the work');
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    errors.push(err.message);
  }
  try {
    loadPolicy(paths);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    errors.push(err.message);
  }
  const { items, errors: backlogErrors } = loadBacklog(paths.backlog);
  errors.push(...backlogErrors);
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    for (const d of item.depends_on ?? []) if (!ids.has(d)) errors.push(`${item.id}: depends on unknown ${d}`);
    if (!item.spec) {
      if (item.status === 'ready') warnings.push(`${item.id}: ready without a spec`);
      continue;
    }
    const specFile = join(root, item.spec);
    if (!existsSync(specFile)) {
      errors.push(`${item.id}: spec ${item.spec} not found`);
      continue;
    }
    const spec = readFileSync(specFile, 'utf8');
    for (const ac of item.criteria ?? []) if (!spec.includes(ac)) errors.push(`${item.id}: ${ac} not found in ${item.spec}`);
    if (item.status === 'ready' && !item.criteria?.length) warnings.push(`${item.id}: ready without acceptance criteria`);
  }
  return { errors, warnings };
}
