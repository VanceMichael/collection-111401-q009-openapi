import { encodePointer, parsePointer } from './pointer.mjs';

const ALLOWED_METHODS = new Set(['get']);
const ALLOWED_PARAM_LOCATIONS = new Set(['path', 'query', 'header']);
// 一份说明文件（OpenAPI 文档）的受控视图：
// - 操作按 operationId 与 JSON Pointer 双索引；operationId 仅在本文件作用域内有效；
// - 只登记 GET 操作，非 GET 不进入可遍历范围；
// - 登记阶段暴露说明自身矛盾（operationId 重复、参数未声明等）。
export function buildSpecModel(document, origin, baseUrl) {
  const issues = [];
  const operations = new Map(); // pointer -> operation view
  const byId = new Map();       // operationId -> pointer（本文件内）
  const paths = document.paths;
  if (!paths || typeof paths !== 'object') {
    issues.push(`说明 ${origin} 缺少 paths 定义`);
  }
  for (const [pathTemplate, pathItem] of Object.entries(paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') {
      issues.push(`路径 ${pathTemplate} 的定义不是对象`);
      continue;
    }
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (method === 'parameters') continue;
      if (!ALLOWED_METHODS.has(method.toLowerCase())) {
        issues.push(`操作 ${method.toUpperCase()} ${pathTemplate} 超出允许范围（只允许 GET），已拒绝登记`);
        continue;
      }
      const upper = method.toUpperCase();
      const operation = rawOperation ?? {};
      const rawParameters = operation.parameters ?? [];
      for (const parameter of rawParameters) {
        if (!ALLOWED_PARAM_LOCATIONS.has(parameter.in)) {
          issues.push(`操作 ${operation.operationId ?? pathTemplate} 出现不支持的参数位置：${parameter.in}`);
        }
      }
      const parameters = rawParameters.filter(parameter => ALLOWED_PARAM_LOCATIONS.has(parameter.in));
      const declared = new Set(parameters.map(parameter => `${parameter.in}:${parameter.name}`));
      for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
        if (!declared.has(`path:${match[1]}`)) {
          issues.push(`路径模板 ${pathTemplate} 的参数 ${match[1]} 未在操作参数中声明`);
        }
      }
      const pointer = operationPointer(pathTemplate, method);
      const view = {
        id: operation.operationId,
        method: upper,
        pathTemplate,
        pointer,
        parameters,
        responses: operation.responses ?? {},
      };
      operations.set(pointer, view);
      if (view.id) {
        if (byId.has(view.id)) issues.push(`说明 ${origin} 中 operationId 重复：${view.id}`);
        else byId.set(view.id, pointer);
      } else {
        issues.push(`操作 ${upper} ${pathTemplate} 缺少 operationId`);
      }
    }
  }
  return {
    origin,
    baseUrl,
    version: document.info?.version,
    title: document.info?.title,
    operations,
    byId,
    issues,
  };
}

// 解析 Link 的目标操作。
// operationId 只在链接所在说明文件内查找；operationRef 的 URI 先相对当前说明解析，
// 再以片段中的 JSON Pointer 定位。绝不跨文件按同名 operationId 混用。
export function resolveLinkTarget(link, sourceSpec, specsByUrl) {
  if (link.operationId !== undefined && link.operationRef !== undefined) {
    return { issue: `链接同时声明 operationId 与 operationRef，说明自相矛盾` };
  }
  if (link.operationId !== undefined) {
    const pointer = sourceSpec.byId.get(link.operationId);
    if (!pointer) return { issue: `operationId 在当前说明中不存在：${link.operationId}` };
    return { spec: sourceSpec, pointer };
  }
  if (link.operationRef !== undefined) {
    let reference;
    try { reference = new URL(link.operationRef, sourceSpec.baseUrl); }
    catch { return { issue: `operationRef 无法解析：${link.operationRef}` }; }
    if (reference.origin !== new URL(sourceSpec.baseUrl).origin) {
      return { issue: `operationRef 指向不同来源，超出授权范围：${reference.origin}` };
    }
    if (!reference.hash.startsWith('#/')) {
      return { issue: `operationRef 缺少 JSON Pointer 片段：${link.operationRef}` };
    }
    const documentUrl = reference.origin + reference.pathname + reference.search;
    const targetSpec = specsByUrl.get(documentUrl);
    if (!targetSpec) return { issue: `operationRef 引用的说明文件未纳入受控范围：${reference.pathname}` };
    let tokens;
    try { tokens = parsePointer(reference.hash.slice(1)); }
    catch (error) { return { issue: error.message }; }
    const pointer = encodePointer(tokens);
    if (!targetSpec.operations.has(pointer)) {
      return { issue: `operationRef 未定位到已登记的 GET 操作：${link.operationRef}` };
    }
    return { spec: targetSpec, pointer };
  }
  return { issue: '链接既未声明 operationId 也未声明 operationRef' };
}

export function operationAt(spec, pointer) {
  return spec.operations.get(pointer);
}

// 构造 OpenAPI 操作在文档中的 JSON Pointer，例如 /paths/~1attachments~1{file}/get。
export function operationPointer(pathTemplate, method) {
  return encodePointer(['paths', pathTemplate, method]);
}

// 从响应描述中挑选实际状态码对应的 links 定义；精确码优先，其次 2XX 这类通配。
export function linksForStatus(operation, status) {
  const exact = operation.responses[String(status)];
  if (exact?.links) return exact.links;
  const wildcard = Object.entries(operation.responses)
    .find(([code]) => /^[1-5]XX$/.test(code) && String(status).startsWith(code[0]));
  return wildcard?.[1]?.links ?? {};
}
