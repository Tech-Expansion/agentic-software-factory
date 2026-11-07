# Native scripts

A wallet's multi-sig accounts are Cardano native scripts. The wallet reads them in the JSON that `cardano-cli` uses,
checks whether a transaction satisfies one, and works out which co-signers to ask for.

## Interface

`src/script.ts` exports:

```ts
export type Script =
  | { type: 'sig'; keyHash: string }
  | { type: 'all'; scripts: Script[] }
  | { type: 'any'; scripts: Script[] }
  | { type: 'atLeast'; required: number; scripts: Script[] }
  | { type: 'after'; slot: number }
  | { type: 'before'; slot: number };

/** `validFrom` is the transaction's lower validity bound (invalid before), `validTo` its upper bound (invalid hereafter). */
export interface Validity { validFrom?: number; validTo?: number }

export class ScriptError extends Error { path: string }

export function parseScript(json: unknown): Script;
export function evaluate(script: Script, tx: Validity & { signers: string[] }): boolean;
export function requiredSigners(script: Script, tx: Validity): string[] | null;
```

The code runs on Node's built-in TypeScript support, so it uses erasable syntax only: no enums, namespaces or
parameter properties (declare `path` as a field and assign it in the constructor). Tests live in `test/` as
`*.test.ts` and run with `node --test`.

## Acceptance criteria

- AC-001: `parseScript` accepts the cardano-cli forms `{"type":"sig","keyHash":"<56 hex>"}`,
  `{"type":"all"|"any","scripts":[...]}`, `{"type":"atLeast","required":n,"scripts":[...]}` and
  `{"type":"after"|"before","slot":n}`, nested to any depth. Key hashes are exactly 56 hexadecimal characters; upper
  case is accepted and returned in lower case. Other fields are ignored.
- AC-002: Anything else throws a `ScriptError` whose `path` names the offending value, starting at `$`: an unknown or
  missing type at `$.scripts[1].type`, a bad key hash at `$.scripts[0].keyHash`, a missing or non-array `scripts` at
  `$.scripts`. `required` and `slot` must be non-negative integers, and `required` at most the number of scripts.
  A value that is not an object at all (null, a string) is reported at its own path, such as `$.scripts[2]`.
- AC-003: `evaluate`: `sig` holds when its key hash is among the signers, compared without regard to case. `all`
  holds when every sub-script holds (an empty `all` holds), `any` when at least one does (an empty `any` does not),
  `atLeast n` when at least n do (`atLeast 0` always holds).
- AC-004: `after s` holds only when `validFrom` is given and `validFrom >= s`; `before s` holds only when `validTo` is
  given and `validTo <= s`. A missing bound never satisfies a time lock.
- AC-005: `requiredSigners` returns a smallest set of key hashes that, with the given validity bounds, satisfies the
  script, in ascending order and lower case, or `null` when no set of signers can (a time lock that fails, an
  `atLeast` that asks for more than it has). Several smallest sets are possible; it returns the one that sorts first
  when the sorted sets are compared element by element. A script with no `sig` that holds gives `[]`.
- AC-006: The same key hash may appear in several branches, and a set counts it once:
  `any(all(A, B), all(A, C), D)` needs `[D]`, and `all(any(B, C), any(C, A))` needs `[C]`. Scripts with up to 20
  distinct keys are answered within a second.
