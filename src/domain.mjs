import { capture } from './client.mjs';
import { runDiscovery } from './discovery.mjs';
import { buildSpecModel } from './spec-model.mjs';
import { Ledger } from './ledger.mjs';
import { reconcile } from './reconcile.mjs';

// 兼容既有入口：收存入口说明并列出其中已登记的操作，不发起业务调用。
export async function receiveCurrent(base, directory) {
  const { bytes, receipt } = await capture(base + '/openapi.json', directory);
  const data = JSON.parse(bytes);
  return {
    receipt: receipt.id,
    version: data.info.version,
    operations: Object.entries(data.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({ path, method, id: operation.operationId }))),
  };
}

// 受控范围由调用方给定。默认贴合当前合作说明：
// 入口说明 /openapi.json，业务根 project=p-1，仅 GET、仅同源。
export function defaultScope(base) {
  const entrySpecUrl = base + '/openapi.json';
  return {
    entrySpecUrl,
    allowedOrigin: new URL(entrySpecUrl).origin,
    seedOperation: 'project',
    seedParams: { path: { project: 'p-1' } },
  };
}

// 依据合作说明发现并领取资料。起点与业务范围完全来自 scope，不做无边界扫描。
export async function discoverAndCollect(base, directory, scope = defaultScope(base)) {
  const allowedOrigin = scope.allowedOrigin ?? new URL(scope.entrySpecUrl).origin;
  const specCache = new Map();

  const loadSpec = async (url) => {
    const target = new URL(url);
    if (target.origin !== allowedOrigin) {
      throw new Error(`说明文件超出允许来源：${target.origin}`);
    }
    if (!specCache.has(url)) {
      const { bytes } = await capture(url, directory);
      const document = JSON.parse(bytes.toString('utf8'));
      specCache.set(url, buildSpecModel(document, target.pathname, url));
    }
    return specCache.get(url);
  };

  const invoke = async ({ url }) => {
    if (url.origin !== allowedOrigin) {
      throw new Error(`目标地址超出允许来源：${url.origin}`);
    }
    const { bytes, receipt, headers, status } = await capture(url.href, directory, {
      method: 'GET',
      redirect: 'manual',
    });
    if (status < 200 || status >= 300) {
      return { status, bytes, headers, receipt, ok: false };
    }
    return { status, bytes, headers, receipt, ok: true };
  };

  const run = await runDiscovery(scope, loadSpec, invoke).catch(error => ({
    id: undefined,
    startedAt: new Date().toISOString(),
    scope,
    documents: [],
    findings: [{ status: 'invalid-spec', reason: `发现流程在说明加载处停止：${error.message}`, trace: [] }],
    basisKeys: [],
  }));
  run.findings = run.findings.map(finding => classify(finding));
  const ledger = new Ledger(directory);
  const previousRun = await ledger.latestRun();
  const saved = await ledger.saveRun(run);
  const reconciliation = reconcile(previousRun, saved);
  return { run: saved, reconciliation };
}

// 失败/阻断类发现不产生可领取对象；成功到达关系终点的发现归入 collected。
function classify(finding) {
  if (finding.status !== 'reached') return finding;
  const calls = (finding.trace ?? []).filter(step => step.kind === 'call');
  const last = calls[calls.length - 1];
  if (last && last.status >= 200 && last.status < 300 && last.receiptId) {
    return { ...finding, status: 'collected', receiptId: last.receiptId, digest: last.digest, url: last.url };
  }
  return { ...finding, status: 'failed' };
}

export async function traceAttachment(directory, receiptId) {
  return new Ledger(directory).traceOfReceipt(receiptId);
}
