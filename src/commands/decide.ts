import { decideLesson } from '../retro.js';
import { answer, type ClarifyOutcome } from './clarify.js';
import { openProduct, UsageError } from './context.js';
import { approve, reject, retry } from './review.js';

export const DECIDE_USAGE = `asf decide <item> approve | reject <reason> | retry | accept | <Q> <answer>
asf decide <lesson> accept | reject`;

export function clarified(o: ClarifyOutcome): string {
  if (o.ready) return `${o.id} is ready to build`;
  if (o.open) return `${o.id}: ${o.open} blocking question(s) open; \`asf\` shows them`;
  return `${o.id}: clear, but not made ready: ${o.note}`;
}

/**
 * Every decision the owner makes, in one command: approve a plan or a change, send it back, let a blocked item run
 * again, answer the product owner's questions (or take every recommendation), accept or reject a lesson.
 */
export function decide(id: string, words: string[], root?: string): string {
  const [what, ...rest] = words;
  const text = rest.join(' ');
  if (/^L-\d+$/.test(id)) {
    if (what !== 'accept' && what !== 'reject') throw new UsageError(DECIDE_USAGE);
    const l = decideLesson(openProduct(root), id, what);
    return `${l.id} ${l.status}${l.applied ? `: ${l.applied}` : ''}`;
  }
  if (!/^B-\d{4}$/.test(id)) throw new UsageError(`not an item (B-0001) or a lesson (L-1): ${id}\n${DECIDE_USAGE}`);
  switch (what) {
    case 'approve': {
      const r = approve(id, root);
      return r.into === 'plan' ? `${id}: plan approved; it is built on the next run` : `merged ${r.merged} into ${r.into}`;
    }
    case 'reject':
      reject(id, text, root);
      return `${id}: sent back; it runs again on the next run`;
    case 'retry':
      retry(id, root);
      return `${id}: it runs again on the next run`;
    case 'accept':
      return clarified(answer(id, undefined, '', { accept: true, root }));
    default:
      if (what && /^Q\d+$/.test(what)) return clarified(answer(id, what, text, { root }));
      throw new UsageError(DECIDE_USAGE);
  }
}
