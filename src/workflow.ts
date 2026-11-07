import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { factoryRoot } from './paths.js';

export interface AgentStep {
  id: string;
  kind: 'agent';
  role: string;
  skills: string[];
  access: 'read' | 'write';
  output?: 'verdict';
  /**
   * `tests`: the step writes acceptance tests, and only test files, once per item before the build. The runner
   * commits them, and later steps cannot change them.
   */
  scope?: 'tests';
}

export interface ChecksStep {
  id: string;
  kind: 'checks';
}

export type Step = AgentStep | ChecksStep;

export interface Workflow {
  name: string;
  steps: Step[];
}

/**
 * Loads `workflows/<name>.yaml`, or a workflow file by path. `without` drops steps by id, to measure with `asf eval`
 * what a step is worth. A failing step sends the item back to the first step with feedback.
 */
export function loadWorkflow(name: string, without: string[] = []): Workflow {
  const file = name.endsWith('.yaml') ? resolve(name) : join(factoryRoot, 'workflows', `${name}.yaml`);
  const wf = parse(readFileSync(file, 'utf8')) as Workflow;
  const missing = without.filter((id) => !wf?.steps?.some((s) => s.id === id));
  if (missing.length) throw new Error(`workflow ${name} has no step ${missing.join(', ')}`);
  if (without.length) wf.steps = wf.steps.filter((s) => !without.includes(s.id));
  if (!wf?.steps?.length || wf.steps[0]?.kind !== 'agent' || (wf.steps[0] as AgentStep).access !== 'write') {
    throw new Error(`workflow ${name}: the first step must be an agent step with write access`);
  }
  for (const s of wf.steps as Step[]) {
    if (s.kind !== 'agent' && s.kind !== 'checks') throw new Error(`workflow ${name}: unknown step kind in ${(s as Step).id}`);
    if (s.kind === 'agent' && (!s.role || !Array.isArray(s.skills))) throw new Error(`workflow ${name}: ${s.id} needs role and skills`);
    if (s.kind === 'agent' && s.scope === 'tests' && (s !== wf.steps[0] || s.access !== 'write')) {
      throw new Error(`workflow ${name}: a tests step must be the first step, with write access`);
    }
  }
  const rest = wf.steps.filter((s) => !(s.kind === 'agent' && s.scope === 'tests'));
  if (rest[0]?.kind !== 'agent' || rest[0].access !== 'write') throw new Error(`workflow ${name}: the build must start with an agent step with write access`);
  return wf;
}
