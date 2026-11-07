import { loadBacklog } from '../backlog.js';
import { day, readEvents } from '../runlog.js';
import { loadState } from '../state.js';
import { board, fmtTokens as fmt } from '../status.js';
import { openProduct } from './context.js';

/** The daily report: what moved, what waits for the user, what is blocked, and what the tokens went to. */
export function report(date: string = day(new Date().toISOString()), root?: string): string {
  const product = openProduct(root);
  const { paths, project } = product;
  const { items } = loadBacklog(paths.backlog);
  const state = loadState(paths.state);
  const events = readEvents(paths.runs, date);
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? '';
  const out: string[] = [`# ${project.name}: report for ${date}`, ''];

  const done = events.filter((e) => e.step === 'approve' && e.outcome === 'done').map((e) => e.item);
  const section = (heading: string, lines: string[]) => {
    out.push(`## ${heading}`, '', ...(lines.length ? lines : ['- none']), '');
  };

  section('Done', done.map((id) => `- ${id} ${title(id)}`));
  section('Waiting for you', board(product).decisions.map((d) => `- ${d.item} ${d.title} [${d.kind}]: ${d.what}; ${d.how}`));
  const ready = items.filter((i) => i.status === 'ready' && !state.items[i.id]).map((i) => `- ${i.id} ${i.title}`);
  section('Next', ready.slice(0, 5));
  const drafts = items.filter((i) => i.status === 'draft').length;
  if (drafts) out.push(`${drafts} item(s) still in draft: run \`asf discover\` to finish planning them.`, '');

  const agent = events.filter((e) => e.kind === 'agent');
  const total = agent.reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
  const byStep = new Map<string, number>();
  for (const e of agent) byStep.set(e.step, (byStep.get(e.step) ?? 0) + (e.tokens?.total ?? 0));
  const reruns = agent.filter((e) => (e.attempt ?? 1) > 1).reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
  section('Tokens', [
    `- total ${fmt(total)} in ${agent.length} agent step(s)`,
    ...[...byStep].map(([step, n]) => `- ${step}: ${fmt(n)}`),
    ...(reruns ? [`- spent on attempts after the first: ${fmt(reruns)}`] : []),
  ]);
  return out.join('\n');
}
