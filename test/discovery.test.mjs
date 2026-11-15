import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiscovery } from '../src/discovery.mjs';
import { buildSpecModel } from '../src/spec-model.mjs';

const ORIGIN = 'http://source.test';

function model(document, path) {
  return buildSpecModel(document, path, ORIGIN + path);
}

function makeLoader(fixtures) {
  const map = new Map(Object.entries(fixtures).map(([path, document]) => [ORIGIN + path, model(document, path)]));
  return async url => {
    const spec = map.get(url);
    if (!spec) throw new Error(`未授权或未知的说明文件：${url}`);
    return spec;
  };
}

// 假 invoke：按 URL 返回登记的响应，记录全部调用，确保测试不依赖真实网络。
function makeInvoke(routes) {
  const calls = [];
  const invoke = async ({ url }) => {
    calls.push(url.pathname + url.search);
    const route = routes[url.pathname + url.search] ?? routes[url.pathname];
    if (!route) return { status: 404, bytes: Buffer.from('{}'), headers: {}, receipt: { id: 'r-' + calls.length } };
    return {
      status: route.status ?? 200,
      bytes: Buffer.from(JSON.stringify(route.body ?? {})),
      headers: route.headers ?? {},
      receipt: { id: 'receipt-' + calls.length, digest: 'd' + calls.length },
    };
  };
  return { invoke, calls };
}

const rootDoc = {
  info: { version: '1' },
  paths: {
    '/projects/{project}': {
      get: {
        operationId: 'project',
        parameters: [{ in: 'path', name: 'project', required: true, schema: { type: 'string' } }],
        responses: { '200': { links: { items: { operationId: 'items', parameters: { project: '$response.body#/id' } } } } },
      },
    },
    '/projects/{project}/items': {
      get: {
        operationId: 'items',
        parameters: [{ in: 'path', name: 'project', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            links: {
              attachment: {
                operationRef: '/attachments-api.json#/paths/~1attachments~1{file}/get',
                parameters: { file: '$response.body#/selected/file', project: '$request.path.project' },
              },
            },
          },
        },
      },
    },
  },
};

const attachmentDoc = {
  info: { version: '1' },
  paths: {
    '/attachments/{file}': {
      get: {
        operationId: 'items', // 与另一说明同名，验证作用域隔离
        parameters: [
          { in: 'path', name: 'file', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'project', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '附件' } },
      },
    },
  },
};

const scope = {
  entrySpecUrl: ORIGIN + '/openapi.json',
  allowedOrigin: ORIGIN,
  seedOperation: 'project',
  seedParams: { path: { project: 'p-1' } },
};

test('沿 Link 关系跨说明发现附件，路径参数斜杠按单值编码', async () => {
  const loader = makeLoader({ '/openapi.json': rootDoc, '/attachments-api.json': attachmentDoc });
  const { invoke, calls } = makeInvoke({
    '/projects/p-1': { body: { id: 'p-1' } },
    '/projects/p-1/items': { body: { selected: { file: 'spec/one' } } },
    '/attachments/spec%2Fone?project=p-1': { body: { file: 'spec/one', content: '材料参数' } },
  });
  const run = await runDiscovery(scope, loader, invoke);
  assert.deepEqual(calls, [
    '/projects/p-1',
    '/projects/p-1/items',
    '/attachments/spec%2Fone?project=p-1',
  ]);
  assert.equal(run.findings.filter(finding => finding.status === 'reached').length, 3);
  const reached = run.findings.find(finding =>
    finding.trace.at(-1).kind === 'call' && finding.trace.at(-1).url.includes('/attachments/'));
  assert.ok(reached);
  const links = reached.trace.filter(step => step.kind === 'link');
  const attachmentLink = links.find(step => step.name === 'attachment');
  assert.equal(attachmentLink.targetDocumentUrl, ORIGIN + '/attachments-api.json');
  assert.equal(attachmentLink.targetOperationId, 'items');
  assert.equal(attachmentLink.params.path.file, 'spec/one');
  // 只领取了授权范围内的两个说明文件与三个 GET 资源。
  assert.deepEqual(run.documents.map(document => document.origin).sort(),
    ['/attachments-api.json', '/openapi.json']);
});

test('关联参数缺失时停在可解释位置，不拼地址不猜测', async () => {
  const loader = makeLoader({ '/openapi.json': rootDoc, '/attachments-api.json': attachmentDoc });
  const { invoke, calls } = makeInvoke({
    '/projects/p-1': { body: { id: 'p-1' } },
    '/projects/p-1/items': { body: { selected: {} } },
  });
  const run = await runDiscovery(scope, loader, invoke);
  const blocked = run.findings.find(finding => finding.status === 'blocked');
  assert.ok(blocked);
  assert.match(blocked.reason, /selected\/file/);
  assert.ok(!calls.some(path => path.startsWith('/attachments/')));
});

test('循环关系在重复节点处停止，不无限遍历', async () => {
  const cyclic = {
    info: { version: '1' },
    paths: {
      '/a/{id}': {
        get: {
          operationId: 'a',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { '200': { links: { self: { operationId: 'a', parameters: { id: '$request.path.id' } } } } },
        },
      },
    },
  };
  const loader = makeLoader({ '/openapi.json': cyclic });
  const { invoke, calls } = makeInvoke({ '/a/p-1': { body: {} } });
  const run = await runDiscovery({ ...scope, seedOperation: 'a', seedParams: { path: { id: 'p-1' } } }, loader, invoke);
  assert.equal(run.findings.filter(finding => finding.status === 'cycle').length, 1);
  assert.deepEqual(calls, ['/a/p-1']);
});

test('说明矛盾（绑定未声明参数、非 GET 目标、跨来源引用）作为 invalid-spec 停止', async () => {
  const contradictory = {
    info: { version: '1' },
    paths: {
      '/a/{id}': {
        get: {
          operationId: 'a',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { '200': { links: { bad: { operationId: 'a', parameters: { ghost: '$request.path.id' } } } } },
        },
      },
    },
  };
  const loader = makeLoader({ '/openapi.json': contradictory });
  const { invoke } = makeInvoke({ '/a/p-1': { body: {} } });
  const run = await runDiscovery({ ...scope, seedOperation: 'a', seedParams: { path: { id: 'p-1' } } }, loader, invoke);
  assert.ok(run.findings.some(finding => finding.status === 'invalid-spec' && /未声明的参数/.test(finding.reason)));

  const crossOrigin = {
    info: { version: '1' },
    paths: {
      '/a/{id}': {
        get: {
          operationId: 'a',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { '200': { links: { out: { operationRef: 'http://other.example/x.json#/paths/~1a/get' } } } },
        },
      },
    },
  };
  const run2 = await runDiscovery(
    { ...scope, seedOperation: 'a', seedParams: { path: { id: 'p-1' } } },
    makeLoader({ '/openapi.json': crossOrigin }), makeInvoke({ '/a/p-1': { body: {} } }).invoke);
  assert.ok(run2.findings.some(finding => finding.status === 'invalid-spec' && /不同来源/.test(finding.reason)));
});

test('响应头表达式可作为关联参数来源', async () => {
  const headerDoc = {
    info: { version: '1' },
    paths: {
      '/start': {
        get: {
          operationId: 'start',
          responses: {
            '200': { links: { next: { operationId: 'next', parameters: { token: '$response.header.x-token' } } } },
          },
        },
      },
      '/next/{token}': {
        get: {
          operationId: 'next',
          parameters: [{ in: 'path', name: 'token', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '终点' } },
        },
      },
    },
  };
  const loader = makeLoader({ '/openapi.json': headerDoc });
  const { invoke, calls } = makeInvoke({
    '/start': { body: {}, headers: { 'x-token': 'tok/1' } },
    '/next/tok%2F1': { body: {} },
  });
  const run = await runDiscovery(
    { ...scope, seedOperation: 'start', seedParams: {} }, loader, invoke);
  assert.deepEqual(calls, ['/start', '/next/tok%2F1']);
  assert.ok(run.findings.some(finding => finding.status === 'reached'));
});
