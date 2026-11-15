import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecModel, resolveLinkTarget, linksForStatus } from '../src/spec-model.mjs';

const baseUrl = 'http://127.0.0.1:8080/openapi.json';

function spec(document, origin = '/openapi.json', url = baseUrl) {
  return buildSpecModel(document, origin, url);
}

test('只登记 GET 操作并暴露说明矛盾', () => {
  const model = spec({
    paths: {
      '/x/{id}': {
        get: { operationId: 'x', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }] },
        post: { operationId: 'write' },
      },
      '/y/{id}': { get: { operationId: 'x', parameters: [] } },
    },
  });
  assert.equal(model.operations.size, 2);
  assert.ok(model.issues.some(issue => /POST/.test(issue)));
  assert.ok(model.issues.some(issue => /operationId 重复/.test(issue)));
  assert.ok(model.issues.some(issue => /未在操作参数中声明/.test(issue)));
});

test('operationId 只在本说明文件内解析，不跨文件混用同名操作', () => {
  const root = spec({
    paths: { '/a': { get: { operationId: 'same', responses: {} } } },
  }, '/openapi.json', 'http://127.0.0.1:8080/openapi.json');
  const other = spec({
    paths: { '/b': { get: { operationId: 'same', responses: {} } } },
  }, '/attachments-api.json', 'http://127.0.0.1:8080/attachments-api.json');
  const specsByUrl = new Map([[root.baseUrl, root], [other.baseUrl, other]]);
  const local = resolveLinkTarget({ operationId: 'same' }, root, specsByUrl);
  assert.equal(local.spec.baseUrl, root.baseUrl);
  const ref = resolveLinkTarget({
    operationRef: '/attachments-api.json#/paths/~1b/get',
  }, root, specsByUrl);
  assert.equal(ref.spec.baseUrl, other.baseUrl);
  assert.equal(ref.pointer, '/paths/~1b/get');
});

test('operationRef 跨来源或指向非 GET 操作时拒绝', () => {
  const root = spec({ paths: { '/a': { get: { operationId: 'a' } } } });
  const specsByUrl = new Map([[root.baseUrl, root]]);
  assert.match(resolveLinkTarget({ operationRef: 'http://other.example/x.json#/paths/~1a/get' }, root, specsByUrl).issue, /不同来源/);
  assert.match(resolveLinkTarget({ operationRef: '/missing.json#/paths/~1a/get' }, root, specsByUrl).issue, /未纳入受控范围/);
  assert.match(resolveLinkTarget({ operationRef: '/openapi.json#/paths' }, root, specsByUrl).issue, /未定位到已登记的 GET/);
  assert.match(resolveLinkTarget({ operationId: 'a', operationRef: '#/x' }, root, specsByUrl).issue, /自相矛盾/);
});

test('按实际状态码选择 links，支持 2XX 通配', () => {
  const model = spec({
    paths: {
      '/a': { get: { operationId: 'a', responses: { '200': { links: { one: {} } }, '2XX': { links: { two: {} } } } } },
    },
  });
  const op = model.operations.get('/paths/~1a/get');
  assert.ok(op);
  assert.deepEqual(Object.keys(linksForStatus(op, 200)), ['one']);
  assert.deepEqual(Object.keys(linksForStatus(op, 204)), ['two']);
  assert.deepEqual(linksForStatus(op, 500), {});
});
