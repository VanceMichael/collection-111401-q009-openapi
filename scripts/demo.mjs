import { createProvider } from '../provider/server.mjs';
import { discoverAndCollect, traceAttachment, defaultScope } from '../src/domain.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function summarize(run) {
  return {
    documents: run.documents.map(document => `${document.origin}@${document.version ?? '?'}`),
    findings: run.findings.map(finding => ({
      status: finding.status,
      reason: finding.reason,
      url: finding.url,
      receiptId: finding.receiptId,
      relations: finding.trace.filter(step => step.kind === 'link').map(step =>
        `${step.sourceDocumentUrl}#${step.name} -> ${step.targetDocumentUrl}#${step.targetPointer}`),
    })),
  };
}

const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
  console.log('== 第一次发现（正常模式，generation=1）==');
  const first = await discoverAndCollect(provider.base, directory);
  console.log(JSON.stringify(summarize(first.run), null, 2));

  const collected = first.run.findings.find(finding =>
    finding.status === 'collected' && finding.trace.at(-1).kind === 'call' && finding.url.includes('/attachments/'));
  console.log('== 附件业务关系回查 ==');
  console.log(JSON.stringify(await traceAttachment(directory, collected.receiptId), null, 2));

  console.log('== 更新说明版本后再次发现（generation=2，结构未变）==');
  await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ generation: 2 }),
  });
  const second = await discoverAndCollect(provider.base, directory, defaultScope(provider.base));
  console.log('对账摘要：' + JSON.stringify(second.reconciliation.summary));

  console.log('== 发布方调整选择导致关联参数缺失（mode=missing）==');
  await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'missing' }),
  });
  const third = await discoverAndCollect(provider.base, directory, defaultScope(provider.base));
  console.log(JSON.stringify({
    findings: summarize(third.run).findings,
    reconciliation: third.reconciliation.summary,
  }, null, 2));

  console.log('== 来源实际收到的请求（仅限受控 GET 与说明文件）==');
  console.log(JSON.stringify(provider.audit.map(({ method, path, query }) => ({ method, path: path + query })), null, 2));
} finally {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}
