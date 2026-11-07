import { runtimeFor } from '../config.js';
import { systemPrompt } from '../prompt.js';
import { openProduct, runtimes } from './context.js';

const SKILLS = ['discovery-interview', 'write-feature-spec', 'plan-backlog'];

const OPENING =
  'Start or continue discovery for this product. Read .factory/project.yaml, product/, specs/ and backlog/ first, ' +
  'then interview me. Ask one question at a time.';

/** An interactive session with the planner, in the user's own CLI. Planning is done with the user, never unattended. */
export function discover(): Promise<number> {
  const { paths, project } = openProduct();
  const runtime = runtimes[runtimeFor(project, 'planner')];
  return runtime.interactive({
    cwd: paths.root,
    systemPrompt: systemPrompt('planner', SKILLS),
    prompt: OPENING,
    model: project.models?.planner,
  });
}
