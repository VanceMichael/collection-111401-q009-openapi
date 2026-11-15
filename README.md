# 接口关系引导的受控资料发现

收件程序依据合作平台交付的 OpenAPI 3.0 说明，从我们给定的入口和业务根出发，沿 Link Object 的关联关系发现并领取采购项目、物料与资料附件；起点、来源与允许的方法都由本地配置限定，不做无边界接口扫描。

## 受控边界

- 入口说明地址、入口操作（默认 `operationId=project`）、业务根参数（默认 `project=p-1`）由调用方在 scope 中给定，见 `defaultScope`。
- 只允许同源请求与 `GET` 方法；非 GET 操作、跨来源的 `operationRef`、链接请求体一律拒绝并记录为说明矛盾，不自行扩张。
- 关联参数只接受说明授权的四类表达式：`$request.path.*`、`$request.query.*`、`$response.header.*`、`$response.body#<JSON Pointer>`；其它写法报告“不支持”，不猜值、不拼地址。
- 路径参数按单个参数编码（`spec/one` 编码为 `spec%2Fone`，斜杠属于参数值而非路径层级）；只跟随响应里发布方明确选择的 `selected` 等字段，不枚举潜在字段。
- 遇到循环关系、缺少必填参数、说明自相矛盾或来源非 2xx 响应时，停在能够解释的位置，产出 `cycle` / `blocked` / `invalid-spec` / `failed` 发现并附原因，不继续猜测。
- `operationId` 的作用域是其所在说明文件；`operationRef` 先相对当前说明解析 URI，再按 JSON Pointer 定位，不同说明中的同名操作不会混用。

## 发现记录与回查

每次发现生成一份运行记录（`<目录>/runs/<id>.json`），每条发现保留完整业务关系链 `trace`：

- `seed`：我们给定的入口操作与业务根；
- `link`：沿哪份说明的哪个 Link、用哪些关联参数走到哪份说明的哪个操作；
- `call`：实际 GET 的地址、状态码、收件凭据 id 与内容摘要。

`traceAttachment(directory, receiptId)` 可凭收件凭据回查任一附件是沿哪条业务关系取得的。原始内容仍以内容寻址方式保存在 `objects/`，凭据在 `receipts/`，与发现记录分开。

## 更新说明后的对账

再次发现时，程序用依据指纹（`basisKeys`：入口、每个 Link、每次调用的说明位置与参数）对比上一轮运行：

- `active`：旧依据在当前说明与数据中仍然成立，内容摘要仍可取得；
- `stale`：旧依据依赖的说明文档、操作或 Link 已消失或改变（依据失效），并列出失效的指纹；
- `unreachable`：依据仍在，但当前发布数据下关联参数缺失或调用被阻断（暂时取不到，不等于依据作废）。

## 运行

使用 Node.js 22。依赖版本已锁定，运行、测试和演示不下载任何数据或软件。运行时只使用 Node.js 内置模块。

- `npm test`：执行单元、收件存储、对账与本地来源端到端测试。
- `npm run build`：逐个检查模块语法。
- `npm run demo`：启动本地来源，依次演示正常发现、附件关系回查、说明版本更新对账、关联参数缺失停止，打印真实收件结果后退出。
- `npm start`：在 127.0.0.1:8080 启动本地来源，PORT 可调整。`GET /health` 返回服务与当前来源版本；原有 `/_health` 仍可使用。

容器方式：`docker build -t collection-openapi .`，然后 `docker run --rm --network none collection-openapi`。镜像构建属于环境准备，运行时不访问公网。

## 项目结构

- `src/domain.mjs`：业务入口。`receiveCurrent` 保留原有人工领取说明能力；`discoverAndCollect` 执行受控发现、落台账并对账；`traceAttachment` 回查业务关系。
- `src/discovery.mjs`：受控遍历引擎（注入式 loadSpec/invoke，支持离线说明夹具验证）。
- `src/spec-model.mjs`：说明建模、操作索引、`operationId`/`operationRef` 解析与矛盾检查。
- `src/expression.mjs` / `src/pointer.mjs`：运行时表达式与 JSON Pointer 求值。
- `src/ledger.mjs` / `src/reconcile.mjs`：发现台账持久化与更新后对账。
- `src/client.mjs`：有限大小（8MB）原始领取，保留响应头与收件凭据。
- `src/archive.mjs`：内容寻址存储与凭据校验。
- `provider/` 是独立的本地来源服务，`docs/source-contract.md` 说明它的资料和状态约定。

本地服务中的机构、记录和文件都是合成业务资料，不使用真实账号、个人信息或第三方站点数据。当前演示通常十秒内结束，全部本地测试应在六十秒内结束。
