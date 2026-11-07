export interface Value {
  lovelace: bigint;
  assets: Record<string, bigint>;
}
export interface Utxo {
  txHash: string;
  index: number;
  value: Value;
}
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

const minFee = (p: Params, inputs: number, outputs: number) => p.feeFixed + p.feePerByte * BigInt(200 + 150 * inputs + 100 * outputs);
const minAda = (p: Params, v: Value) => p.minUtxoBase + p.minUtxoPerAsset * BigInt(Object.keys(v.assets).length);
const qty = (v: Value, asset: string) => (asset === 'lovelace' ? v.lovelace : (v.assets[asset] ?? 0n));

function sum(values: Value[]): Value {
  const out: Value = { lovelace: 0n, assets: {} };
  for (const v of values) {
    out.lovelace += v.lovelace;
    for (const [a, q] of Object.entries(v.assets)) out.assets[a] = (out.assets[a] ?? 0n) + q;
  }
  return out;
}

/** The highest-ranked unselected UTxO by an amount, among those that hold some of it. */
function best(utxos: Utxo[], taken: Set<Utxo>, asset: string): Utxo | undefined {
  let top: Utxo | undefined;
  for (const u of utxos) {
    if (taken.has(u) || qty(u.value, asset) <= 0n) continue;
    if (!top) {
      top = u;
      continue;
    }
    const a = qty(u.value, asset);
    const b = qty(top.value, asset);
    if (a > b || (a === b && (u.txHash < top.txHash || (u.txHash === top.txHash && u.index < top.index)))) top = u;
  }
  return top;
}

export function selectCoins(utxos: Utxo[], outputs: Value[], params: Params): Selection {
  const bad = outputs.findIndex((o) => o.lovelace < minAda(params, o));
  if (bad >= 0) return { ok: false, error: 'output-below-min-utxo', output: bad };

  const requested = sum(outputs);
  const inputs: Utxo[] = [];
  const taken = new Set<Utxo>();
  const add = (asset: string): Selection | undefined => {
    if (inputs.length >= params.maxInputs) return { ok: false, error: 'too-many-inputs' };
    const u = best(utxos, taken, asset);
    if (!u) return { ok: false, error: 'insufficient', asset };
    inputs.push(u);
    taken.add(u);
    return undefined;
  };

  for (const asset of Object.keys(requested.assets).sort()) {
    while (qty(sum(inputs.map((u) => u.value)), asset) < requested.assets[asset]!) {
      const failed = add(asset);
      if (failed) return failed;
    }
  }

  for (;;) {
    const have = sum(inputs.map((u) => u.value));
    const excessAssets: Record<string, bigint> = {};
    for (const [a, q] of Object.entries(have.assets)) {
      const left = q - (requested.assets[a] ?? 0n);
      if (left > 0n) excessAssets[a] = left;
    }
    const excess = have.lovelace - requested.lovelace;
    const withChange = minFee(params, inputs.length, outputs.length + 1);
    if (Object.keys(excessAssets).length) {
      const change = { lovelace: excess - withChange, assets: excessAssets };
      if (change.lovelace >= minAda(params, change)) return { ok: true, inputs, change, fee: withChange };
    } else if (excess - withChange >= params.minUtxoBase) {
      return { ok: true, inputs, change: { lovelace: excess - withChange, assets: {} }, fee: withChange };
    } else if (excess >= minFee(params, inputs.length, outputs.length)) {
      return { ok: true, inputs, change: null, fee: excess };
    }
    const failed = add('lovelace');
    if (failed) return failed;
  }
}
