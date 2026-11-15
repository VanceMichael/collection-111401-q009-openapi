// RFC 6901 JSON Pointer 解析与求值；OpenAPI 3.0 的 $response.body# 片段使用该语法。

export function parsePointer(pointer) {
  if (typeof pointer !== 'string' || pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`不是合法的 JSON Pointer：${pointer}`);
  return pointer.slice(1).split('/').map(token =>
    token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function evaluatePointer(value, tokens) {
  let current = value;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const index = Number(token);
      current = index < current.length ? current[index] : undefined;
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = current[token];
    }
  }
  return current;
}

export function encodePointer(tokens) {
  if (tokens.length === 0) return '';
  return '/' + tokens.map(token =>
    String(token).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}
