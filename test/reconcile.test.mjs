import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.mjs';

function previousRun() {
  return {
    id: 'prev',
    startedAt: '2026-11-14T00:00:00.000Z',
    findings: [
      {
        id: 'f-collected',
        status: 'collected',
        trace: [
          { kind: 'seed', basisKey: 'seed:root#/paths/~1projects~1{project}/get:{}' },
          { kind: 'link', basisKey: 'link:root#attachment->att#/paths/~1attachments~1{file}/get' },
          { kind: 'call', basisKey: 'call:att#/paths/~1attachments~1{file}/get:200:{}', receiptId: 'r2', digest: 'digest-2' },
        ],
      },
      { id: 'f-blocked', status: 'blocked', reason: '参数缺失', trace: [{ kind: 'seed', basisKey: 'seed:root#x:{}' }] },
    ],
    basisKeys: [],
  };
}

const allBasisKeys = [
  'seed:root#/paths/~1projects~1{project}/get:{}',
  'link:root#attachment->att#/paths/~1attachments~1{file}/get',
  'call:att#/paths/~1attachments~1{file}/get:200:{}',
  'seed:root#x:{}',
];

test('依据指纹仍在且内容摘要仍可达时判为 active', () => {
  const current = { basisKeys: allBasisKeys, findings: [{ trace: [{ digest: 'digest-2' }] }] };
  const result = reconcile(previousRun(), current);
  assert.equal(result.items[0].status, 'active');
  // 阻断类发现即使依据仍在，也只是当前不可达，不冒充有效收件。
  assert.equal(result.items[1].status, 'unreachable');
});

test('说明更新移除旧链接时，旧发现判为 stale 并给出失效依据', () => {
  const current = {
    basisKeys: [
      'seed:root#/paths/~1projects~1{project}/get:{}',
      'seed:root#x:{}',
    ],
    findings: [{ trace: [{ digest: 'digest-other' }] }],
  };
  const result = reconcile(previousRun(), current);
  const item = result.items[0];
  assert.equal(item.status, 'stale');
  assert.ok(item.staleBasisKeys.some(key => key.startsWith('link:')));
  assert.equal(result.summary.stale, 1);
});

test('依据仍在但本轮内容摘要变化时判为 unreachable', () => {
  const current = { basisKeys: allBasisKeys, findings: [{ trace: [{ digest: 'digest-changed' }] }] };
  const result = reconcile(previousRun(), current);
  assert.equal(result.items[0].status, 'unreachable');
});

test('没有历史运行时返回空对账', () => {
  const result = reconcile(null, { basisKeys: [], findings: [] });
  assert.deepEqual(result.summary, { active: 0, stale: 0, unreachable: 0 });
});
