import { parsePointer, evaluatePointer } from './pointer.mjs';

// OpenAPI 3.0 运行时表达式求值。
// 合作说明只授权四类表达式：
//   $request.path.<name>、$request.query.<name>、$response.header.<name>、$response.body#<json-pointer>
// 其它写法（含 $request.body、$status 等）一律视为不支持，不做猜测。
const REQUEST_PATTERN = /^\$request\.(path|query)\.([^.]+)$/;
const HEADER_PATTERN = /^\$response\.header\.([^.]+)$/;
const BODY_PATTERN = /^\$response\.body#(\/.*)?$/;

export function evaluateExpression(expression, context) {
  if (typeof expression !== 'string' || expression === '') {
    return { ok: false, reason: `不支持的关联表达式：${String(expression)}` };
  }
  const requestMatch = expression.match(REQUEST_PATTERN);
  if (requestMatch) {
    const [, location, name] = requestMatch;
    const values = location === 'path' ? context.request.path : context.request.query;
    return present(values?.[name])
      ? { ok: true, value: values[name] }
      : { ok: false, reason: `请求${location === 'path' ? '路径' : '查询'}参数缺失：${name}` };
  }
  const headerMatch = expression.match(HEADER_PATTERN);
  if (headerMatch) {
    const name = headerMatch[1].toLowerCase();
    const value = context.response.headers?.[name];
    return present(value)
      ? { ok: true, value }
      : { ok: false, reason: `响应头缺失：${headerMatch[1]}` };
  }
  const bodyMatch = expression.match(BODY_PATTERN);
  if (bodyMatch) {
    if (context.response.body === undefined) {
      return { ok: false, reason: '响应不是可解析的 JSON 主体，无法取值' };
    }
    let tokens;
    try { tokens = parsePointer(bodyMatch[1] ?? ''); }
    catch (error) { return { ok: false, reason: error.message }; }
    const value = evaluatePointer(context.response.body, tokens);
    return present(value)
      ? { ok: true, value }
      : { ok: false, reason: `响应主体不存在所选字段：${expression}` };
  }
  return { ok: false, reason: `不支持的关联表达式：${expression}` };
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}
