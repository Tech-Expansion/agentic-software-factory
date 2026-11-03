import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { factoryRoot } from './paths.js';

export interface AgentStep {
  id: string;
  kind: 'agent';
  role: string;
  skills: string[];
  access: 'read' | 'write';
  output?: 'verdict';
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

/** Loads `workflows/<name>.yaml`. A failing step sends the item back to the first step with feedback. */
export function loadWorkflow(name: string): Workflow {
  const wf = parse(readFileSync(join(factoryRoot, 'workflows', `${name}.yaml`), 'utf8')) as Workflow;
  if (!wf?.steps?.length || wf.steps[0]?.kind !== 'agent' || (wf.steps[0] as AgentStep).access !== 'write') {
    throw new Error(`workflow ${name}: the first step must be an agent step with write access`);
  }
  for (const s of wf.steps as Step[]) {
    if (s.kind !== 'agent' && s.kind !== 'checks') throw new Error(`workflow ${name}: unknown step kind in ${(s as Step).id}`);
    if (s.kind === 'agent' && (!s.role || !Array.isArray(s.skills))) throw new Error(`workflow ${name}: ${s.id} needs role and skills`);
  }
  return wf;
}
