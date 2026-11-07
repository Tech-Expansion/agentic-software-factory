import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCoins, type Params, type Utxo, type Value } from '../src/select.ts';

const params: Params = { feeFixed: 155_381n, feePerByte: 44n, minUtxoBase: 1_000_000n, minUtxoPerAsset: 200_000n, maxInputs: 10 };
const v = (lovelace: bigint, assets: Record<string, bigint> = {}): Value => ({ lovelace, assets });
const u = (txHash: string, index: number, value: Value): Utxo => ({ txHash, index, value });
const ids = (inputs: Utxo[]) => inputs.map((i) => `${i.txHash}#${i.index}`);

/** inputs = outputs + change + fee, in lovelace and in every asset. */
function balanced(inputs: Utxo[], outputs: Value[], change: Value | null, fee: bigint) {
  const total = (vs: Value[]) => {
    const t: Record<string, bigint> = { lovelace: 0n };
    for (const x of vs) {
      t.lovelace! += x.lovelace;
      for (const [a, q] of Object.entries(x.assets)) t[a] = (t[a] ?? 0n) + q;
    }
    return t;
  };
  const left = total(inputs.map((i) => i.value));
  const right = total([...outputs, ...(change ? [change] : []), v(fee)]);
  for (const a of new Set([...Object.keys(left), ...Object.keys(right)])) assert.equal(left[a] ?? 0n, right[a] ?? 0n, `balance of ${a}`);
}

function ok(utxos: Utxo[], outputs: Value[], p = params) {
  const r = selectCoins(utxos, outputs, p);
  assert.equal(r.ok, true, JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? `${x}n` : x)));
  if (!r.ok) throw new Error('unreachable');
  balanced(r.inputs, outputs, r.change, r.fee);
  return r;
}

test('AC-001 an output below its minimum lovelace is refused first', () => {
  assert.deepEqual(selectCoins([], [v(2_000_000n), v(1_100_000n, { 'p.a': 5n })], params), { ok: false, error: 'output-below-min-utxo', output: 1 });
  assert.deepEqual(selectCoins([u('aa', 0, v(50_000_000n))], [v(999_999n)], params), { ok: false, error: 'output-below-min-utxo', output: 0 });
  const atMin = v(1_400_000n, { 'p.a': 5n, 'p.b': 1n });
  ok([u('aa', 0, v(50_000_000n, { 'p.a': 5n, 'p.b': 1n }))], [atMin]);
});

test('AC-002 assets first, in asset id order, by the most of that asset', () => {
  const A = u('a1', 0, v(2_000_000n, { 'p1.tok': 50n }));
  const B = u('a2', 0, v(1_500_000n, { 'p1.tok': 80n, 'p0.nft': 1n }));
  const C = u('a3', 0, v(20_000_000n));
  const D = u('a4', 0, v(1_300_000n, { 'p1.tok': 30n }));
  const r = ok([A, B, C, D], [v(3_000_000n, { 'p1.tok': 100n, 'p0.nft': 1n })]);
  assert.deepEqual(ids(r.inputs), ['a2#0', 'a1#0', 'a3#0']);
  assert.deepEqual(r.change, v(20_307_219n, { 'p1.tok': 30n }));
  assert.equal(r.fee, 192_781n);
  assert.deepEqual(selectCoins([A, B, C, D], [v(3_000_000n, { 'p1.tok': 200n })], params), { ok: false, error: 'insufficient', asset: 'p1.tok' });
  assert.deepEqual(selectCoins([A, B, C, D], [v(3_000_000n, { 'p1.tok': 10n, 'p0.nft': 2n })], params), { ok: false, error: 'insufficient', asset: 'p0.nft' });
  assert.deepEqual(selectCoins([A, C], [v(3_000_000n, { 'q.x': 1n })], params), { ok: false, error: 'insufficient', asset: 'q.x' });
});

test('AC-003 then lovelace, most first, ties by txHash then index', () => {
  const r = ok([u('aa', 0, v(5_000_000n)), u('bb', 0, v(3_000_000n)), u('cc', 0, v(10_000_000n))], [v(4_000_000n)]);
  assert.deepEqual(ids(r.inputs), ['cc#0']);
  const t = ok([u('bb', 1, v(3_000_000n)), u('bb', 0, v(3_000_000n)), u('ab', 5, v(3_000_000n))], [v(5_000_000n)]);
  assert.deepEqual(ids(t.inputs), ['ab#5', 'bb#0']);
  assert.deepEqual(selectCoins([u('aa', 0, v(1_000_000n)), u('bb', 0, v(1_000_000n))], [v(5_000_000n)], params), { ok: false, error: 'insufficient', asset: 'lovelace' });
});

test('AC-004 change, or none with the excess as fee, or one more input', () => {
  const change = ok([u('cc', 0, v(10_000_000n))], [v(4_000_000n)]);
  assert.deepEqual(change.change, v(5_820_419n));
  assert.equal(change.fee, 179_581n);

  const none = ok([u('aa', 0, v(4_500_000n))], [v(4_000_000n)]);
  assert.equal(none.change, null);
  assert.equal(none.fee, 500_000n);

  const more = ok([u('aa', 0, v(4_100_000n)), u('bb', 0, v(2_000_000n))], [v(4_000_000n)]);
  assert.deepEqual(ids(more.inputs), ['aa#0', 'bb#0']);
  assert.deepEqual(more.change, v(1_913_819n));
  assert.equal(more.fee, 186_181n);

  // Excess assets force a change output, so 0.5 ADA of excess is not enough and a lovelace input is added.
  const forced = ok([u('t', 0, v(1_500_000n, { 'p.a': 9n })), u('z', 0, v(3_000_000n))], [v(1_200_000n, { 'p.a': 1n })]);
  assert.deepEqual(ids(forced.inputs), ['t#0', 'z#0']);
  assert.deepEqual(forced.change, v(3_113_819n, { 'p.a': 8n }));
});

test('AC-005 never more than maxInputs', () => {
  const ones = Array.from({ length: 6 }, (_, i) => u(`h${i + 1}`, 0, v(1_000_000n)));
  assert.deepEqual(selectCoins(ones, [v(3_000_000n)], { ...params, maxInputs: 2 }), { ok: false, error: 'too-many-inputs' });
  assert.deepEqual(selectCoins(ones.slice(0, 2), [v(5_000_000n)], { ...params, maxInputs: 2 }), { ok: false, error: 'too-many-inputs' });
  assert.deepEqual(selectCoins(ones.slice(0, 2), [v(5_000_000n)], { ...params, maxInputs: 3 }), { ok: false, error: 'insufficient', asset: 'lovelace' });
  const tokens = [u('a1', 0, v(2_000_000n, { 'p.t': 50n })), u('a2', 0, v(2_000_000n, { 'p.t': 80n }))];
  assert.deepEqual(selectCoins(tokens, [v(1_200_000n, { 'p.t': 100n })], { ...params, maxInputs: 1 }), { ok: false, error: 'too-many-inputs' });
  const r = ok(ones, [v(3_000_000n)], { ...params, maxInputs: 4 });
  assert.equal(r.inputs.length, 4);
});

test('AC-006 exact amounts, no zero assets, arguments left alone', () => {
  const big = 2n ** 60n;
  const r = ok([u('x', 0, v(big))], [v(2n ** 59n)]);
  assert.deepEqual(r.change, v(2n ** 59n - 179_581n));

  const huge = ok([u('x', 0, v(10_000_000n, { 'p.big': 2n ** 64n }))], [v(2_000_000n, { 'p.big': 1n })]);
  assert.deepEqual(huge.change, v(7_820_419n, { 'p.big': 2n ** 64n - 1n }));

  const exact = ok([u('z', 0, v(5_000_000n, { 'p.a': 5n }))], [v(2_000_000n, { 'p.a': 5n })]);
  assert.deepEqual(exact.change, v(2_820_419n), 'an asset spent in full is not in the change');

  const utxos = [u('a1', 0, v(2_000_000n, { 'p1.tok': 50n })), u('a2', 0, v(1_500_000n, { 'p1.tok': 80n })), u('a3', 0, v(20_000_000n))];
  const outputs = [v(3_000_000n, { 'p1.tok': 100n })];
  const before = structuredClone({ utxos, outputs });
  const twice = ok(utxos, outputs);
  assert.deepEqual({ utxos, outputs }, before);
  assert.equal(new Set(twice.inputs).size, twice.inputs.length, 'each UTxO at most once');
  assert.deepEqual(ok(utxos, outputs), twice, 'the same answer every time');
});
