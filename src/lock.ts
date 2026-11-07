import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class LockError extends Error {}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One process at a time works on a product: `asf run` and `asf serve` take `.factory/lock`. A lock left by a process
 * that is gone is taken over, so a crash never needs a manual cleanup.
 */
export function acquire(factory: string, what: string): () => void {
  const file = join(factory, 'lock');
  if (existsSync(file)) {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; what: string; at: string };
    if (held.pid !== process.pid && alive(held.pid)) throw new LockError(`asf ${held.what} (pid ${held.pid}) is already working on this product, since ${held.at}`);
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }) + '\n');
  return () => {
    if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid === process.pid) rmSync(file);
  };
}
