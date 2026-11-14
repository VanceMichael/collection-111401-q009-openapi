export const initialState = { generation: 1, mode: 'normal', clock: 1000 };
export async function stop(state) {  }
export async function routes(context) {
 const { request, url, body, payload, state, json, text, binary } = context;

 if(url.pathname==='/openapi.json') return json({openapi:'3.0.3',info:{title:'采购资料',version:String(state.generation)},paths:{'/projects/{project}':{get:{operationId:'project',parameters:[{in:'path',name:'project',required:true,schema:{type:'string'}}],responses:{'200':{description:'项目',links:{items:{operationId:'items',parameters:{project:'$response.body#/id'}}}}}}},'/projects/{project}/items':{get:{operationId:'items',parameters:[{in:'path',name:'project',required:true,schema:{type:'string'}}],responses:{'200':{description:'物料',links:{attachment:{operationRef:'/attachments-api.json#/paths/~1attachments~1{file}/get',parameters:{file:'$response.body#/selected/file',project:'$request.path.project'}}}}}}}}});
 if(url.pathname==='/attachments-api.json') return json({openapi:'3.0.3',info:{title:'附件资料',version:'1'},paths:{'/attachments/{file}':{get:{operationId:'items',parameters:[{in:'path',name:'file',required:true,schema:{type:'string'}},{in:'query',name:'project',required:true,schema:{type:'string'}}],responses:{'200':{description:'附件'}}}}}});
 if(url.pathname==='/projects/p-1') return json({id:'p-1',title:'采购项目'});
 if(url.pathname==='/projects/p-1/items') return json({selected:state.mode==='missing'?{}:{file:'spec/one'},rows:[{id:'part-1'}]});
 if(url.pathname==='/attachments/spec%2Fone') return json({file:'spec/one',project:url.searchParams.get('project'),content:'材料参数'});

}
