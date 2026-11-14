import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

test('接口说明完整声明所有模板路径参数',async()=>{
 const provider=await createProvider();
 try{for(const address of ['/openapi.json','/attachments-api.json']){const document=await(await fetch(provider.base+address)).json();for(const [path,methods]of Object.entries(document.paths)){for(const match of path.matchAll(/\{([^}]+)\}/g)){const definition=methods.get.parameters.find(parameter=>parameter.in==='path'&&parameter.name===match[1]);assert.equal(definition.required,true);assert.equal(definition.schema.type,'string');}}}}finally{await provider.close();}
});

test('现有业务入口真实收存来源资料并可重新打开', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'business-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    assert.ok(provider.audit.some(request => !request.path.startsWith('/_')));
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('不同说明允许存在相同操作名', async () => {
 const provider = await createProvider();
 try {
const root=await(await fetch(provider.base+'/openapi.json')).json();const other=await(await fetch(provider.base+'/attachments-api.json')).json();assert.equal(root.paths['/projects/{project}/items'].get.operationId,other.paths['/attachments/{file}'].get.operationId);
 } finally { await provider.close(); }
});

test('路径参数的斜杠属于参数值', async () => {
 const provider = await createProvider();
 try {
const data=await(await fetch(provider.base+'/attachments/spec%2Fone?project=p-1')).json();assert.equal(data.file,'spec/one');assert.equal(data.project,'p-1');
 } finally { await provider.close(); }
});

test('缺少关联值不会提供猜测目标', async () => {
 const provider = await createProvider();
 try {
await controlled(provider,{mode:'missing'});assert.deepEqual((await(await fetch(provider.base+'/projects/p-1/items')).json()).selected,{});
 } finally { await provider.close(); }
});
