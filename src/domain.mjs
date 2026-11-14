import { capture } from './client.mjs';
export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/openapi.json', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, version: data.info.version, operations: Object.entries(data.paths).flatMap(([path,methods])=>Object.entries(methods).map(([method,operation])=>({path,method,id:operation.operationId}))) };
}
