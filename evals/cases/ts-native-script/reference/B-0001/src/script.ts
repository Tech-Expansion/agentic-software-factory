export type Script =
  | { type: 'sig'; keyHash: string }
  | { type: 'all'; scripts: Script[] }
  | { type: 'any'; scripts: Script[] }
  | { type: 'atLeast'; required: number; scripts: Script[] }
  | { type: 'after'; slot: number }
  | { type: 'before'; slot: number };

export interface Validity {
  validFrom?: number;
  validTo?: number;
}

export class ScriptError extends Error {
  path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function parseScript(json: unknown, path = '$'): Script {
  if (!isObject(json)) throw new ScriptError(path, 'not an object');
  switch (json.type) {
    case 'sig': {
      const k = json.keyHash;
      if (typeof k !== 'string' || !/^[0-9a-fA-F]{56}$/.test(k)) throw new ScriptError(`${path}.keyHash`, 'not a 56-character hex key hash');
      return { type: 'sig', keyHash: k.toLowerCase() };
    }
    case 'all':
    case 'any':
      return { type: json.type, scripts: parseList(json.scripts, `${path}.scripts`) };
    case 'atLeast': {
      const scripts = parseList(json.scripts, `${path}.scripts`);
      if (!isCount(json.required) || json.required > scripts.length) throw new ScriptError(`${path}.required`, 'not a count of at most the number of scripts');
      return { type: 'atLeast', required: json.required, scripts };
    }
    case 'after':
    case 'before':
      if (!isCount(json.slot)) throw new ScriptError(`${path}.slot`, 'not a non-negative integer');
      return { type: json.type, slot: json.slot };
    default:
      throw new ScriptError(`${path}.type`, 'unknown or missing type');
  }
}

function parseList(v: unknown, path: string): Script[] {
  if (!Array.isArray(v)) throw new ScriptError(path, 'not an array');
  return v.map((s, i) => parseScript(s, `${path}[${i}]`));
}

function holds(s: Script, signers: Set<string>, tx: Validity): boolean {
  switch (s.type) {
    case 'sig':
      return signers.has(s.keyHash.toLowerCase());
    case 'all':
      return s.scripts.every((x) => holds(x, signers, tx));
    case 'any':
      return s.scripts.some((x) => holds(x, signers, tx));
    case 'atLeast':
      return s.scripts.filter((x) => holds(x, signers, tx)).length >= s.required;
    case 'after':
      return tx.validFrom !== undefined && tx.validFrom >= s.slot;
    case 'before':
      return tx.validTo !== undefined && tx.validTo <= s.slot;
  }
}

export function evaluate(script: Script, tx: Validity & { signers: string[] }): boolean {
  return holds(script, new Set(tx.signers.map((k) => k.toLowerCase())), tx);
}

function keys(s: Script, out: Set<string>): Set<string> {
  if (s.type === 'sig') out.add(s.keyHash.toLowerCase());
  else if ('scripts' in s) for (const x of s.scripts) keys(x, out);
  return out;
}

/** The script as a test over key indexes, with its time locks already decided. */
function compile(s: Script, index: Map<string, number>, tx: Validity): (has: Uint8Array) => boolean {
  switch (s.type) {
    case 'sig': {
      const i = index.get(s.keyHash.toLowerCase())!;
      return (has) => has[i] === 1;
    }
    case 'all': {
      const parts = s.scripts.map((x) => compile(x, index, tx));
      return (has) => parts.every((p) => p(has));
    }
    case 'any': {
      const parts = s.scripts.map((x) => compile(x, index, tx));
      return (has) => parts.some((p) => p(has));
    }
    case 'atLeast': {
      const parts = s.scripts.map((x) => compile(x, index, tx));
      const need = s.required;
      return (has) => {
        let n = 0;
        for (const p of parts) if (p(has) && ++n >= need) return true;
        return n >= need;
      };
    }
    case 'after':
    case 'before': {
      const ok = holds(s, new Set(), tx);
      return () => ok;
    }
  }
}

/**
 * Tries sizes from the smallest. Within a size, a depth-first search that takes a key before leaving it out visits
 * the sets in lexicographic order, so the first one that holds is the answer. Adding signers never breaks a script,
 * so a branch is dropped as soon as the keys it chose plus all it has not decided on no longer satisfy it.
 */
export function requiredSigners(script: Script, tx: Validity): string[] | null {
  const all = [...keys(script, new Set())].sort();
  const test = compile(script, new Map(all.map((k, i) => [k, i])), tx);
  const chosen = new Uint8Array(all.length);
  const available = new Uint8Array(all.length).fill(1);
  if (!test(available)) return null;
  let count = 0;
  const search = (i: number, size: number): boolean => {
    if (count === size) return test(chosen);
    if (all.length - i < size - count || !test(available)) return false;
    chosen[i] = 1;
    count++;
    if (search(i + 1, size)) return true;
    chosen[i] = 0;
    count--;
    available[i] = 0;
    const found = search(i + 1, size);
    available[i] = 1;
    return found;
  };
  for (let size = 0; size <= all.length; size++) if (search(0, size)) return all.filter((_, i) => chosen[i] === 1);
  return null;
}
