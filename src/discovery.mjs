import { randomUUID } from 'node:crypto';
import { buildSpecModel, resolveLinkTarget, linksForStatus } from './spec-model.mjs';
import { evaluateExpression } from './expression.mjs';

const MAX_VISITS = 64;

// 受控发现引擎。
// scope：
//   entrySpecUrl  入口说明地址（我们给定）
//   seedOperation 入口操作的 operationId（我们给定，只在入口说明内解析）
//   seedParams    入口路径/查询参数（业务根，例如 project=p-1）
//   allowedOrigin 允许的来源（同源约束，跨来源一律停在说明处）
// loadSpec 负责领取并解析说明文件；invoke 负责真正发起 GET。
// 两者均可注入，便于用固定说明做离线验证，避免无边界扫描。
export async function runDiscovery(scope, loadSpec, invoke) {
  const startedAt = new Date().toISOString();
  const findings = [];
  const documents = [];
  const specsByUrl = new Map();
  const basisKeys = new Set();
  const visited = new Set();
  let visits = 0;

  const entrySpec = await loadSpec(scope.entrySpecUrl);
  registerSpec(entrySpec);
  for (const issue of entrySpec.issues) pushIssue(issue, []);

  const seedParams = normalizeParams(scope.seedParams);
  const seedPointer = entrySpec.byId.get(scope.seedOperation);
  if (!seedPointer) {
    pushIssue(`入口操作 ${scope.seedOperation} 不在入口说明中，拒绝启动`, []);
  } else {
    const seedBasis = `seed:${entrySpec.baseUrl}#${seedPointer}:${stableJson(seedParams)}`;
    basisKeys.add(seedBasis);
    await visit(entrySpec, seedPointer, seedParams, [{
      kind: 'seed',
      documentUrl: entrySpec.baseUrl,
      documentVersion: entrySpec.version,
      operationId: scope.seedOperation,
      pointer: seedPointer,
      params: seedParams,
      basisKey: seedBasis,
    }]);
  }

  return {
    id: randomUUID(),
    startedAt,
    scope: {
      entrySpecUrl: scope.entrySpecUrl,
      seedOperation: scope.seedOperation,
      seedParams,
      allowedOrigin: scope.allowedOrigin,
    },
    documents,
    findings,
    basisKeys: [...basisKeys].sort(),
  };

  function registerSpec(spec) {
    if (specsByUrl.has(spec.baseUrl)) return;
    specsByUrl.set(spec.baseUrl, spec);
    documents.push({
      url: spec.baseUrl,
      origin: spec.origin,
      version: spec.version,
      title: spec.title,
      issues: [...spec.issues],
    });
  }

  function pushFinding(finding) { findings.push({ id: randomUUID(), ...finding }); }
  function pushIssue(reason, trace) {
    pushFinding({ status: 'invalid-spec', reason, trace: [...trace] });
  }

  function nodeKey(spec, pointer, params) {
    return `${spec.baseUrl}#${pointer}|${stableJson(params)}`;
  }

  async function visit(spec, pointer, params, trace) {
    if (visits >= MAX_VISITS) {
      pushFinding({ status: 'blocked', reason: `已达遍历上限 ${MAX_VISITS}，停止扩张`, trace });
      return;
    }
    const operation = spec.operations.get(pointer);
    if (!operation) {
      pushIssue(`目标操作不在说明索引中：${pointer}`, trace);
      return;
    }
    const key = nodeKey(spec, pointer, params);
    if (visited.has(key)) {
      pushFinding({ status: 'cycle', reason: '检测到重复的业务关系节点，停止该分支以避免循环', trace });
      return;
    }
    visited.add(key);
    visits += 1;

    for (const parameter of operation.parameters) {
      if (parameter.required && !present(params[parameter.in]?.[parameter.name])) {
        pushFinding({
          status: 'blocked',
          reason: `操作 ${operation.id ?? operation.pathTemplate} 缺少必填${parameter.in}参数 ${parameter.name}，不产生调用`,
          trace,
        });
        return;
      }
    }

    let url;
    try { url = buildUrl(spec, operation, params); }
    catch (error) {
      pushFinding({ status: 'blocked', reason: error.message, trace });
      return;
    }

    let result;
    try { result = await invoke({ url, spec, operation, params }); }
    catch (error) {
      pushFinding({ status: 'failed', reason: error.message, trace, target: { url: url.href, method: 'GET' } });
      return;
    }

    const callBasis = `call:${spec.baseUrl}#${pointer}:${result.status}:${stableJson(params)}`;
    basisKeys.add(callBasis);
    const step = {
      kind: 'call',
      documentUrl: spec.baseUrl,
      documentVersion: spec.version,
      operationId: operation.id,
      pointer,
      method: operation.method,
      url: url.href,
      status: result.status,
      receiptId: result.receipt?.id,
      digest: result.receipt?.digest,
      basisKey: callBasis,
    };
    const nextTrace = [...trace, step];

    if (result.status < 200 || result.status >= 300) {
      pushFinding({
        status: 'failed',
        reason: `来源返回 ${result.status}，该业务关系停在此处`,
        trace: nextTrace,
        target: { url: url.href, method: 'GET' },
      });
      return;
    }

    let body;
    if (result.bytes) {
      try { body = JSON.parse(result.bytes.toString('utf8')); }
      catch { body = undefined; }
    }
    const responseContext = {
      request: { path: params.path ?? {}, query: params.query ?? {} },
      response: { status: result.status, headers: lowerHeaders(result.headers), body },
    };

    const links = linksForStatus(operation, result.status);
    const linkEntries = Object.entries(links);
    // 每个成功到达的 GET 节点都留一条发现记录（中间节点与附件终点都可回查）。
    pushFinding({
      status: 'reached',
      reason: linkEntries.length === 0 ? '已到达关联关系终点' : '已按说明关系取得业务资源',
      trace: nextTrace,
    });
    for (const [linkName, link] of linkEntries) {
      await expandLink(linkName, link, spec, params, responseContext, nextTrace);
    }
  }

  async function expandLink(linkName, link, sourceSpec, currentParams, responseContext, trace) {
    if (!link || typeof link !== 'object') {
      pushIssue(`链接 ${linkName} 定义不是对象`, trace);
      return;
    }
    // operationRef 可能指向另一份说明文件：按需领取并登记，仍受同源约束。
    if (link.operationRef !== undefined) {
      try {
        const reference = new URL(link.operationRef, sourceSpec.baseUrl);
        const documentUrl = reference.origin + reference.pathname + reference.search;
        if (reference.origin === scope.allowedOrigin && !specsByUrl.has(documentUrl)) {
          const loaded = await loadSpec(documentUrl);
          specsByUrl.set(documentUrl, loaded);
          documents.push({
            url: loaded.baseUrl,
            origin: loaded.origin,
            version: loaded.version,
            title: loaded.title,
            issues: [...loaded.issues],
          });
          for (const issue of loaded.issues) pushIssue(issue, trace);
        }
      } catch {
        // 无法解析的引用交给 resolveLinkTarget 产出可解释结论。
      }
    }
    const target = resolveLinkTarget(link, sourceSpec, specsByUrl);
    if (target.issue) {
      pushIssue(`链接 ${linkName} 无法解析：${target.issue}`, trace);
      return;
    }
    const targetSpec = target.spec;
    registerSpec(targetSpec);
    for (const issue of targetSpec.issues) pushIssue(issue, trace);
    const targetOperation = targetSpec.operations.get(target.pointer);
    if (link.requestBody !== undefined || link.requestBodyExpression !== undefined) {
      pushIssue(`链接 ${linkName} 携带请求体，超出仅 GET 的授权范围`, trace);
      return;
    }

    const bound = { path: {}, query: {} };
    for (const [parameterName, expression] of Object.entries(link.parameters ?? {})) {
      const declaration = targetOperation.parameters.find(parameter => parameter.name === parameterName);
      if (!declaration) {
        pushIssue(`链接 ${linkName} 为目标操作绑定了未声明的参数 ${parameterName}`, trace);
        return;
      }
      if (declaration.in === 'header') {
        pushIssue(`链接 ${linkName} 绑定了 header 参数 ${parameterName}，当前领取范围不支持`, trace);
        return;
      }
      const evaluated = evaluateExpression(expression, responseContext);
      if (!evaluated.ok) {
        pushFinding({
          status: 'blocked',
          reason: `链接 ${linkName} 的关联参数 ${parameterName} 无效：${evaluated.reason}`,
          trace,
          link: linkName,
        });
        return;
      }
      if (!isScalar(evaluated.value)) {
        pushFinding({
          status: 'blocked',
          reason: `链接 ${linkName} 的关联参数 ${parameterName} 不是单一标量值，拒绝拼接地址`,
          trace,
          link: linkName,
        });
        return;
      }
      bound[declaration.in][parameterName] = String(evaluated.value);
    }

    for (const parameter of targetOperation.parameters) {
      if (!parameter.required) continue;
      if (!present(bound[parameter.in]?.[parameter.name])) {
        pushFinding({
          status: 'blocked',
          reason: `链接 ${linkName} 缺少目标必填参数 ${parameter.in}.${parameter.name}，不产生有效调用`,
          trace,
          link: linkName,
        });
        return;
      }
    }

    const linkBasis = `link:${sourceSpec.baseUrl}#${linkName}->${targetSpec.baseUrl}#${target.pointer}`;
    basisKeys.add(linkBasis);
    const linkStep = {
      kind: 'link',
      name: linkName,
      sourceDocumentUrl: sourceSpec.baseUrl,
      sourceDocumentVersion: sourceSpec.version,
      targetDocumentUrl: targetSpec.baseUrl,
      targetDocumentVersion: targetSpec.version,
      targetOperationId: targetOperation.id,
      targetPointer: target.pointer,
      params: { path: bound.path, query: bound.query },
      basisKey: linkBasis,
    };
    await visit(targetSpec, target.pointer, { path: bound.path, query: bound.query }, [...trace, linkStep]);
  }
}

function normalizeParams(params = {}) {
  return {
    path: stringifyMap(params.path ?? {}),
    query: stringifyMap(params.query ?? {}),
  };
}

function stringifyMap(map) {
  return Object.fromEntries(Object.entries(map).map(([name, value]) => [name, String(value)]));
}

function buildUrl(spec, operation, params) {
  const base = new URL(spec.baseUrl);
  let pathname = operation.pathTemplate.replace(/\{([^}]+)\}/g, (match, name) => {
    const value = params.path?.[name];
    if (!present(value)) throw new Error(`路径参数 ${name} 缺失，无法构造地址`);
    return encodeURIComponent(value); // 单参数编码：spec/one 的斜杠属于参数值，编码为 %2F
  });
  const url = new URL(pathname, base);
  for (const [name, value] of Object.entries(params.query ?? {})) {
    if (present(value)) url.searchParams.set(name, value);
  }
  return url;
}

function lowerHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) result[name.toLowerCase()] = value;
  return result;
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function isScalar(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function stableJson(value) {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
