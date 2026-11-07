import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCoins } from '../src/select.ts';

test('AC-003/AC-004 smoke', () => {
  const p = { feeFixed: 155_381n, feePerByte: 44n, minUtxoBase: 1_000_000n, minUtxoPerAsset: 200_000n, maxInputs: 10 };
  const r = selectCoins([{ txHash: 'cc', index: 0, value: { lovelace: 10_000_000n, assets: {} } }], [{ lovelace: 4_000_000n, assets: {} }], p);
  assert.equal(r.ok && r.fee, 179_581n);
});
