# Coin selection

To send, the wallet picks which of its UTxOs to spend, works out the fee, and returns the rest to itself as change.
Amounts are exact: lovelace and asset quantities are `bigint`.

## Interface

`src/select.ts` exports:

```ts
/** `assets` maps an asset id ("<policy id>.<asset name>") to a quantity above zero. */
export interface Value { lovelace: bigint; assets: Record<string, bigint> }
export interface Utxo { txHash: string; index: number; value: Value }
export interface Params {
  feeFixed: bigint;
  feePerByte: bigint;
  minUtxoBase: bigint;
  minUtxoPerAsset: bigint;
  maxInputs: number;
}
export type Selection =
  | { ok: true; inputs: Utxo[]; change: Value | null; fee: bigint }
  | { ok: false; error: 'output-below-min-utxo'; output: number }
  | { ok: false; error: 'insufficient'; asset: string }
  | { ok: false; error: 'too-many-inputs' };

export function selectCoins(utxos: Utxo[], outputs: Value[], params: Params): Selection;
```

The code runs on Node's built-in TypeScript support, so it uses erasable syntax only: no enums, namespaces or
parameter properties. Tests live in `test/` as `*.test.ts` and run with `node --test`.

## Definitions

- The size of a transaction with `i` inputs and `o` outputs (the change output included, when there is one) is
  `200 + 150 * i + 100 * o` bytes, and its minimum fee is `feeFixed + feePerByte * size`.
- The minimum lovelace of an output is `minUtxoBase + minUtxoPerAsset * n`, where n is its number of distinct assets.
- The requested value is the sum of the outputs. The excess is what the selected inputs hold beyond it, per asset
  and in lovelace (it can be negative while inputs are still being added).
- UTxOs are ranked by an amount from most to least; ties go to the smaller `txHash` (string order), then the smaller
  `index`.

## Acceptance criteria

- AC-001: Before anything is selected, every output must hold at least its minimum lovelace. Otherwise the result is
  `output-below-min-utxo` with the index of the first output that does not.
- AC-002: Assets first. For each asset the outputs ask for, in ascending order of asset id: while the selected inputs
  hold less of it than requested, add the unselected UTxO ranked highest by its quantity of that asset. If no UTxO
  with that asset is left, the result is `insufficient` with that asset id.
- AC-003: Then lovelace. While the selection is not balanced (AC-004), add the unselected UTxO ranked highest by
  lovelace. If none is left, the result is `insufficient` with asset `"lovelace"`.
- AC-004: The selection is balanced when one of these holds, tried in this order:
  1. The excess holds an asset. Then a change output holding the excess assets is needed, with lovelace equal to the
     excess lovelace minus the minimum fee with that change output; it must be at least the change output's minimum
     lovelace.
  2. The excess holds no asset, and the excess lovelace minus the minimum fee with a change output is at least
     `minUtxoBase`. Then that amount is the change output, with no assets.
  3. The excess holds no asset, and the excess lovelace is at least the minimum fee without a change output. Then
     there is no change (`change: null`), and the whole excess lovelace is the fee.
- AC-005: The result never uses more than `maxInputs` inputs. When AC-002 or AC-003 needs another input and
  `maxInputs` are already selected, the result is `too-many-inputs`, whether or not a UTxO is left to add.
- AC-006: On success `inputs` are in the order they were added, each UTxO at most once; `fee` is the fee of the case
  in AC-004 that holds; and inputs = outputs + change + fee exactly, in lovelace and in every asset. Change has no
  asset with quantity zero. The arguments are not changed. Amounts above 2^53 stay exact.
