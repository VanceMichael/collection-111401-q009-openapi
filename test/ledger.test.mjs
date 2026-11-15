import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.mjs';

function runFixture(id, startedAt, findings) {
  return { id, startedAt, scope: {}, documents: [], findings, basisKeys: [] };
}

test('运行记录持久化并可按收件凭据回查业务关系链', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const ledger = new Ledger(directory);
    const run = runFixture('run-1', '2026-11-15T10:00:00.000Z', [{
      id: 'f-1',
      status: 'collected',
      receiptId: 'rc-9',
      trace: [
        { kind: 'seed', basisKey: 'seed:x' },
        { kind: 'call', receiptId: 'rc-1', basisKey: 'call:1' },
        { kind: 'link', basisKey: 'link:1' },
        { kind: 'call', receiptId: 'rc-9', basisKey: 'call:2' },
      ],
    }]);
    await ledger.saveRun(run);
    const listed = await ledger.listRuns();
    assert.equal(listed.length, 1);
    assert.equal((await ledger.latestRun()).id, 'run-1');
    const trace = await ledger.traceOfReceipt('rc-9');
    assert.equal(trace.runId, 'run-1');
    assert.equal(trace.trace.length, 4);
    assert.equal(await ledger.traceOfReceipt('unknown'), null);
    // 临时文件不进入记录列表。
    await (await import('node:fs/promises')).writeFile(join(directory, 'runs', 'x.pending'), '{');
    assert.equal((await readdir(join(directory, 'runs'))).filter(name => name.endsWith('.json')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('多次运行按 startedAt 取最新', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-latest-'));
  try {
    const ledger = new Ledger(directory);
    await ledger.saveRun(runFixture('old', '2026-11-14T00:00:00.000Z', []));
    await ledger.saveRun(runFixture('new', '2026-11-15T00:00:00.000Z', []));
    assert.equal((await ledger.latestRun()).id, 'new');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
