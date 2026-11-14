# 采购资料接口说明

入口说明为 `/openapi.json`，采用 OpenAPI 3.0 Link Object。允许来源只有当前服务，业务根为 project=p-1；遍历操作仅允许 GET。operationId 的作用域是其说明文件，operationRef 的 URI 先相对当前说明解析，再按 JSON Pointer 定位，不能把另一说明中的同名操作混用。

Link parameters 可以使用 `$request.path.*`、`$request.query.*`、`$response.header.*`、`$response.body#...`；缺失值不产生有效调用。路径参数按单个参数编码，spec/one 的斜杠不是路径层级。响应中的 selected 是发布方明确选择的关联对象，不授权枚举所有潜在字段或猜测标识。

mode=missing 使关联参数缺失；generation 改变说明版本。可以报告不支持的表达式或说明矛盾，不得自行扩张到其他方法、来源或项目。

## 本地演练控制

`GET /_health` 返回服务健康状态；`GET /_audit` 仅返回请求路径、方法和体积，不记录凭据。`POST /_control` 接收 JSON，可调整 generation、mode、clock。控制端点只服务于本地演练，不是资料接口，也不是浏览器业务操作入口。每次重新启动服务都会恢复初始数据；生产接入时不部署此控制面。
