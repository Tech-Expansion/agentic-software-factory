import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklog } from '../backlog.js';
import { ConfigError, loadPolicy, loadProject } from '../config.js';
import { findProductRoot, productPaths } from '../paths.js';
import { loadRole, loadSkill } from '../prompt.js';
import { loadWorkflow, writesTests } from '../workflow.js';
import { version } from '../version.js';
import { UsageError } from './context.js';

/**
 * Checks settings, policy and backlog, that every spec and criterion a backlog item names exists, and that every
 * workflow in use loads with the roles and skills it names.
 */
export function validateProduct(cwd: string = process.cwd()): { errors: string[]; warnings: string[] } {
  const root = findProductRoot(cwd);
  if (!root) throw new UsageError('no .factory/project.yaml here or above');
  const paths = productPaths(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  let workflow: string | undefined;
  try {
    const project = loadProject(paths);
    workflow = project.workflow;
    if (project.factory_version !== version) {
      warnings.push(`project.yaml pins factory ${project.factory_version}, this is ${version}`);
    }
    if (!project.commands.check.length) warnings.push('commands.check is empty: nothing but a model checks the work');
    for (const role of project.specialists ?? []) {
      try {
        loadRole(role, paths.factory);
      } catch (err) {
        errors.push(`project.yaml specialists: ${(err as Error).message}`);
      }
    }
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
    // A spec is optional: a small product lists the criteria in the item itself, as "- AC-001: ...".
    if (!item.spec) {
      if (item.status === 'ready' && !/\bAC-\d{3}\b/.test(item.body)) warnings.push(`${item.id}: ready without acceptance criteria (in a spec, or in the item as "- AC-001: ...")`);
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

  const own = join(paths.factory, 'workflows');
  const local = existsSync(own) ? readdirSync(own).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -'.yaml'.length)) : [];
  const used = new Map<string, string>(local.map((n) => [n, `.factory/workflows/${n}.yaml`]));
  if (workflow && !used.has(workflow)) used.set(workflow, 'project.yaml');
  for (const item of items) if (item.workflow && !used.has(item.workflow)) used.set(item.workflow, item.id);
  for (const [name, where] of used) {
    try {
      const wf = loadWorkflow(name, [], paths.factory);
      for (const step of wf.steps) {
        if (step.kind !== 'agent') continue;
        for (const load of [() => loadRole(step.role, paths.factory), ...step.skills.map((sk) => () => loadSkill(sk, paths.factory))]) {
          try {
            load();
          } catch (err) {
            errors.push(`${where}: workflow ${name}, step ${step.id}: ${(err as Error).message}`);
          }
        }
      }
      if (name === 'feature' && local.includes('feature') && !writesTests(wf)) {
        warnings.push('.factory/workflows/feature.yaml has no tests step: high-risk items, and quick changes to sensitive paths, will be blocked');
      }
    } catch (err) {
      errors.push(`${where}: ${(err as Error).message}`);
    }
  }
  return { errors, warnings };
}
