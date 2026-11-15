import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { discoverAndCollect, traceAttachment, defaultScope, receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change),
  });
  assert.equal(response.status, 200);
}

test('从给定入口沿说明关系领取项目、物料和附件', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'e2e-'));
  try {
    const { run, reconciliation } = await discoverAndCollect(provider.base, directory);
    assert.equal(reconciliation.summary.active, 0); // 首次运行无历史
    const collected = run.findings.filter(finding => finding.status === 'collected');
    const urls = collected.map(finding => finding.url);
    assert.ok(urls.some(url => url.endsWith('/projects/p-1')));
    assert.ok(urls.some(url => url.endsWith('/projects/p-1/items')));
    assert.ok(urls.includes(provider.base + '/attachments/spec%2Fone?project=p-1'));

    // 附件 trace 可回查整条业务关系：project -> items(link) -> attachment
    const attachment = collected.find(finding =>
      finding.trace.at(-1).kind === 'call' && finding.url.includes('/attachments/'));
    const traced = await traceAttachment(directory, attachment.receiptId);
    assert.equal(traced.finding.id, attachment.id);
    const linkSteps = traced.trace.filter(step => step.kind === 'link');
    const linkStep = linkSteps.find(step => step.name === 'attachment');
    assert.equal(linkStep.name, 'attachment');
    assert.equal(linkStep.targetDocumentUrl, provider.base + '/attachments-api.json');
    assert.equal(linkStep.params.path.file, 'spec/one');
    assert.equal(linkStep.params.query.project, 'p-1');
    const calls = traced.trace.filter(step => step.kind === 'call');
    assert.deepEqual(calls.map(step => step.operationId), ['project', 'items', 'items']);

    // 每个收件都可凭凭据重新打开且校验通过。
    const archive = new Archive(directory);
    for (const receipt of await archive.list()) {
      assert.ok((await archive.read(receipt)).length > 0);
    }

    // 实际请求只落在同源 GET，且没有控制面或枚举路径。
    const business = provider.audit.filter(entry => !entry.path.startsWith('/_'));
    assert.ok(business.every(entry => entry.method === 'GET'));
    assert.ok(business.every(entry =>
      entry.path.startsWith('/projects/') ||
      entry.path.startsWith('/attachments/') ||
      entry.path.endsWith('api.json')));
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('说明同名操作按文件作用域解析，不会错调另一说明的操作', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'scope-'));
  try {
    const { run } = await discoverAndCollect(provider.base, directory);
    const attachment = run.findings.find(finding =>
      finding.status === 'collected' && finding.trace.at(-1).kind === 'call' && finding.url.includes('/attachments/'));
    const link = attachment.trace.filter(step => step.kind === 'link').find(step => step.name === 'attachment');
    // 根说明的 items 是物料列表；附件说明的同名 items 必须经 operationRef 精确定位。
    assert.equal(link.targetPointer, '/paths/~1attachments~1{file}/get');
    assert.notEqual(link.sourceDocumentUrl, link.targetDocumentUrl);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('关联参数缺失时停止且不产生附件地址，再次运行给出 unreachable 对账', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'missing-'));
  try {
    await discoverAndCollect(provider.base, directory);
    await controlled(provider, { mode: 'missing' });
    const before = provider.audit.length;
    const second = await discoverAndCollect(provider.base, directory, defaultScope(provider.base));
    const blocked = second.run.findings.find(finding => finding.status === 'blocked');
    assert.ok(blocked);
    assert.match(blocked.reason, /selected\/file/);
    const secondRound = provider.audit.slice(before);
    assert.ok(!secondRound.some(entry => entry.path.startsWith('/attachments/') && entry.method === 'GET'));
    // 附件关系本轮无法走通：至少一条历史发现变为不可达或依据失效，且都给出可解释原因。
    assert.ok(second.reconciliation.items.some(item =>
      item.status === 'unreachable' || item.status === 'stale'));
    const staleAttachment = second.reconciliation.items.find(item =>
      item.staleBasisKeys?.some(key => key.includes('attachments')));
    assert.ok(staleAttachment, '应明确指出附件相关的旧依据已无法复现');
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('说明版本更新后重新发现，结构未变时历史依据仍有效', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'generation-'));
  try {
    await discoverAndCollect(provider.base, directory);
    await controlled(provider, { generation: 3 });
    const { run, reconciliation } = await discoverAndCollect(provider.base, directory, defaultScope(provider.base));
    assert.equal(run.documents.find(document => document.origin === '/openapi.json').version, '3');
    assert.equal(reconciliation.summary.stale, 0);
    assert.ok(reconciliation.summary.active >= 1);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('原有人工领取入口保持可用', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'legacy-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.equal(result.version, '1');
    assert.ok(result.operations.some(operation => operation.id === 'project'));
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
