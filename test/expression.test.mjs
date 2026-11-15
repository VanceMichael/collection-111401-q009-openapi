import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression } from '../src/expression.mjs';
import { parsePointer, evaluatePointer, encodePointer } from '../src/pointer.mjs';

const context = {
  request: { path: { project: 'p-1' }, query: { page: '2' } },
  response: {
    status: 200,
    headers: { 'x-trace': 'abc', location: '/here' },
    body: { id: 'p-1', selected: { file: 'spec/one' }, rows: [{ id: 'part-1' }] },
  },
};

test('四类授权表达式都能从请求、响应头和嵌套主体取值', () => {
  assert.equal(evaluateExpression('$request.path.project', context).value, 'p-1');
  assert.equal(evaluateExpression('$request.query.page', context).value, '2');
  assert.equal(evaluateExpression('$response.header.x-trace', context).value, 'abc');
  assert.equal(evaluateExpression('$response.header.X-Trace', context).value, 'abc');
  assert.equal(evaluateExpression('$response.body#/selected/file', context).value, 'spec/one');
  assert.equal(evaluatePointer(context.response.body, parsePointer('/rows/0/id')), 'part-1');
});

test('缺失字段返回可解释原因而不是 undefined 拼接', () => {
  const result = evaluateExpression('$response.body#/selected/missing', context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不存在所选字段/);
  assert.equal(evaluateExpression('$request.path.other', context).ok, false);
  assert.equal(evaluateExpression('$response.header.absent', context).ok, false);
  assert.equal(evaluateExpression('$response.body#', context).value, context.response.body);
});

test('未授权的表达式写法被明确拒绝', () => {
  for (const expression of ['$request.body#/id', '$status', '$url', 'http://other/x', '', null]) {
    assert.equal(evaluateExpression(expression, context).ok, false, String(expression));
  }
});

test('JSON Pointer 的转义与重建', () => {
  assert.deepEqual(parsePointer('/a~1b/~0c'), ['a/b', '~c']);
  assert.equal(encodePointer(['a/b', '~c']), '/a~1b/~0c');
  assert.equal(evaluatePointer({ a: [1, 2] }, parsePointer('/a/1')), 2);
  assert.equal(evaluatePointer({ a: [1, 2] }, parsePointer('/a/9')), undefined);
});
