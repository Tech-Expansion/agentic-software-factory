import { modelFor, runtimeFor, type RuntimeName } from '../config.js';
import type { Runtime } from '../runtimes/types.js';
import { systemPrompt } from '../prompt.js';
import { openProduct, runtimes } from './context.js';
import { chooseStack } from './stack.js';

const SKILLS = ['discovery-interview', 'market-scan', 'write-feature-spec', 'plan-backlog'];

const OPENING =
  'Start or continue discovery for this product. Read .factory/project.yaml, product/, specs/ and backlog/ first, ' +
  'then interview me. Ask one question at a time.';

/**
 * An interactive session with the product owner, in the user's own CLI. Planning is done with the user, never
 * unattended. Afterwards, while the product has no checks, the tech lead chooses the stack from what was settled.
 */
export async function discover(opts: { runtime?: (n: RuntimeName) => Runtime; log?: (msg: string) => void } = {}): Promise<number> {
  const product = openProduct();
  const { paths, project } = product;
  const runtime = opts.runtime ?? ((n: RuntimeName) => runtimes[n]);
  const code = await runtime(runtimeFor(project, 'product-owner')).interactive({
    cwd: paths.root,
    systemPrompt: systemPrompt('product-owner', SKILLS, paths.factory),
    prompt: OPENING,
    model: modelFor(project, 'product-owner'),
  });
  if (code !== 0) return code;
  const said = await chooseStack({ ...product, runtime });
  if (said) (opts.log ?? console.log)(said);
  return 0;
}
