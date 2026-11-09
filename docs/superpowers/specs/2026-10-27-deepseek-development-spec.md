# TapeCI 开发交接 SPEC — DeepSeek 执行版

版本：1.0，2026-10-27。状态：可用于分阶段开发；供应接口、商业规则和真实付款验收另有明确门槛。  
用途：交给未参与前期讨论的开发 Agent，从当前仓库实现“钱包发现 → 缺项准备 → 项目构建 → 审批发布 → 网站访问”。  
本轮只新增文档，没有实现本文接口，没有运行本文测试，没有执行购买、签名或主网交易。

## 0. 给执行 Agent 的入口说明

### 0.1 阅读顺序与优先关系

1. 当前用户指令、宿主权限规则和适用的 AGENTS.md。
2. 本文：固定本次新增功能的行为、数据、API、验收和默认实现选择。
3. [产品设计](../../reports/TapeCI-Wallet-Onboarding-and-Release-Design-2026-10-27.md)：用户意图和业务解释。
4. [开发计划及 15 项问题](../plans/2026-10-27-wallet-resource-provisioning.md)：任务拆分及源码证据。
5. 仓库 `TapeCI_PRD_Technical_Design.md`、当前 schema/migration、链配置和 P0/P1/P2 证据。

本文是 v0.1 规格的细化；接口命名、字段和执行默认选择以本文为准。旧 PRD 排除采购/容器开通的范围已被用户本轮需求扩展；其安全写链、静态站点、Manifest、验证和每容器串行约束继续有效。

**不要把本文理解为重写项目。** 在现有模块上增量开发，已实现的审批、上传、回滚、证据、比较、预算、成员、组织、审计、通知、翻译和 UI 必须保留。

### 0.2 工作区和检查基线

- 仓库：`https://github.com/novus77/TapeCI`。
- 编写本文时本地路径：`/Users/a77/Desktop/tapeout`，分支 `main`，HEAD `3eab5e2`，存在其他未提交改动。
- 前轮问题审查基线为 `c5eb8e3` 加当时工作区。开始修复前逐项复核，已经修复的问题只补验证，不重复修改。
- 用户要求后续开发以 `origin/dev` 为基线；先查 ref，缺失时报告具体基线问题，不静默用 main 替代。不切换或清空当前脏工作区。
- 分支按用户要求最多三个词、用连字符分隔、无类型前缀/斜杠；若宿主有更高优先级约束，明确记录实际使用规则。
- 不自行提交、推送、部署、修改 GitHub App 权限或发送主网付费交易。
- 不读取/输出私钥和 Secret；沿用已有环境配置入口。文档示例不包含可用密钥。

### 0.3 本期可立即开发与外部依赖

| 可以立即开发 | 等待真实材料后开放 |
| --- | --- |
| 钱包连接修复、公开资源查询、单项资产复核、索引接口 | 未确认的购买/mint/流片供应接口 |
| 已有电路的容器开启报价、fork 验证和准备任务 | 平台库存商品、交付、定价、退款与售后规则 |
| 草稿、构建门禁、日志/尝试模型、审批恢复、精确费用、站点摘要 | 真实 GitHub dispatch 所需未授权权限或测试仓库 |
| 独立 PG、fork、受控测试和响应式验收 | 用户手机/硬件设备签名、限额明确的真实付款 |

供应来源缺失时，真实返回 `available=false` 和具体原因。继续开发已有资源路径；不得为等待材料而停止全部任务，也不得模拟“购买成功”。

## 1. 产品结果与非目标

用户连接钱包，平台展示其电路及所属处理器编号，推导关联容器。已有可用资源直接选用，有电路但未开启则只开启；无资源时可选平台提供的供应方案。一套准备过程有统一报价、逐步确认、持久进度和交付验收，最终接入 GitHub 项目并发布网站。

“一套”不承诺一笔交易、一次签名或跨合约原子执行。用户钱包默认自行支付；平台不持有用户主钱包私钥。首期只支持 X Layer `196`，原生 gas 币为 OKB；采购首个来源只开放已经验证的支付币种，不自动引入换币、跨链、ERC-20 授权或平台代付。

不新增动态后端托管、自动生产部署、无条件无人审批、独立钱包登录或通用商城。已有项目无需先购买新套餐才能继续使用。

## 2. 必须正确的领域模型

| 概念 | 正确含义 | 不得混淆 |
| --- | --- | --- |
| processor | Factory 注册的电路 NFT 合约/系列 | Factory 目录不等于钱包拥有所有处理器 |
| processorIndex | Factory 的目录编号 | 不单独作为资产主键或所有权证明 |
| circuit | processor 下的 NFT tokenId | 不直接等同于容器、域名或网站套餐额度 |
| container | 协议从 processor/tokenId 推导的账户 | 地址可推导不等于已部署或已开启 |
| wallet verification | 登录用户证明控制某个地址 | 不等于签署购买、转账或发布授权 |
| provisioning | 资源获取、开启及可选激活 | 完成准备不等于网站 LIVE |
| deployment | 固定 commit 的构建、计划、审批、链上发布 | 构建成功不等于上传/验证/激活成功 |
| site access | 域名绑定、有效期、网关可读 | receipt success 或历史 LIVE 不等于当前网站可访问 |

资产键为 `(chainId, processor, tokenId)`，container 必须服务端推导。保存规范化小写地址，对 UI 可显示 checksum；tokenId/wei/blockNumber 通过 API 使用十进制字符串，禁止 Number 转换造成精度损失。

## 3. 用户流程与页面行为

### 3.1 已有资源

1. 打开 `/resources`，连接钱包或输入地址。
2. 显示处理器分组、电路编号、容器地址、deployed/opened、读取区块、完整性状态。
3. 点击“使用此电路”时重新核验 owner 和容器，不能只相信索引快照。
4. 已开启：进入项目草稿/配置，无采购步骤；未开启：生成 open 准备报价。
5. 保存草稿、配置仓库与路径策略，准备检查通过后显式启用构建。

### 3.2 无资源或选购新资源

1. 只有完整同步且确实无资产，才显示“未发现电路”；RPC 失败显示查询失败。
2. 展示可用资源来源、商品、交付对象和缺项；已有资源仍可切回使用。
3. 匿名用户可看目录和估价；登录后验证交付钱包，生成最终报价和任务。
4. 用户审阅每项费用和预计交易次数，建立任务，然后逐步在钱包确认。
5. acquisition 完成并核验实际资源后，再决定 open 是否必要。不得在 tokenId 未知时构造虚假的容器地址。
6. 资源已获得但后续失败：保留成果，只继续缺失步骤。

### 3.3 任务恢复

- 刷新后从任务 API 加载；浏览器 localStorage 不是订单事实源。
- 钱包拒签：停在 awaiting_signature，原费用不记已花费，允许再次确认。
- 钱包已广播且有 hash：显示 submitted，等待确认，禁止“再买一次”。
- 用户已广播但页面在回传 hash 前关闭：保留发送意图，展示“结果待核验”；允许补充原 hash，不能自动再次广播。
- 超时不等于失败；仅在证明原尝试 reverted/canceled 或未广播且用户确认后才能重新构造付费尝试。
- 切换钱包后可以查看自己的旧任务，但不能改变旧任务接收者；继续操作需要原交付钱包。

### 3.4 页面范围

| 页面 | 必须可见的主要信息和操作 |
| --- | --- |
| `/resources` | 钱包/网络、公开地址查询、分组资产、同步状态、刷新、手工编号补查、使用/准备 |
| `/resources/prepare` | 所选资源或 offer、缺项、费用/币种、交付钱包、报价时效、确认准备 |
| `/preparations/[id]` | 总状态、逐步结果、当前操作、交易/错误/恢复、已获得资源、进入项目 |
| `/projects/new` | 创建/继续草稿、选仓库、选资源、构建命令、输出目录、pathMode、准备检查 |
| `/projects/[id]` | 当前版本、最近部署、构建启用状态、公开 URL、域名有效期、最后访问检查、下一步 |
| `/deployments/[id]` | 构建 run/job/attempt、日志/源链接、失败恢复、费用/签名摘要、原证据 tabs |
| `/containers/[address]` | 原有详情、可直接连接钱包的激活操作、激活交易跟踪、session 风险与恢复链接 |

沿用 GitLab 风格，使用既有 token、组件、i18n 和响应式模式。失败先呈现错误与恢复，审批先呈现将签内容；完整证据通过原详情入口保留。不得用删除功能来缩短页面。

## 4. 模块与源码改动地图

| 文件/模块 | 开发职责 |
| --- | --- |
| `packages/shared/src/resources.ts`（新增） | 资源 DTO、状态和读取结果契约 |
| `packages/shared/src/provisioning.ts`（新增） | 报价、步骤、任务和交易结果 DTO |
| `packages/chain/src/container.ts` | 区分真实 false、无 token 与 RPC failure；返回 deployed/opened |
| `apps/api/src/resources.ts`, `resource-index.ts`（新增） | 发现候选、同步、链核验与公开投影 |
| `apps/api/src/routes/resources.ts`（新增） | 公共目录/地址查询；不放宽原私有容器 API |
| `apps/api/src/provisioning/quotes.ts`（新增） | 最终报价、过期/金额/接收者边界 |
| `apps/api/src/provisioning/tasks.ts`（新增） | 幂等任务和步骤迁移 |
| `apps/api/src/provisioning/transactions.ts`（新增） | 意图、hash 归因、receipt/交付/规范链核验 |
| `apps/api/src/provisioning/providers.ts`（新增） | 供应接口和默认 unavailable，open 内建来源 |
| `apps/api/src/worker/provisioning.ts`（新增） | 从 PG 未完成步骤恢复核验；不自动替用户签名购买 |
| `apps/api/src/routes/provisioning.ts`（新增） | 下文报价、任务、准备、提交和核验 API |
| `packages/database/src/schema.ts`、增量 migrations | 索引、报价、准备任务、草稿和构建尝试 |
| `apps/api/src/routes/projects.ts`, `builds.ts` | 草稿、启用门禁、尝试 API |
| `packages/github/src/webhook.ts`、Actions 示例 | 区分 push admission、外部构建与 artifact；回报开始/失败 |
| `apps/api/src/build-runs.ts`（新增） | 精确 SHA/config 的 trigger、run/job/attempt 关联 |
| `apps/api/src/project-access.ts`, `routes/deployments.ts` | 统一有效角色、真实 capability、重签和 resume |
| `packages/queue/src/state-machine.ts`, worker runtime | 在原状态机上增量接通恢复，保留 journal |
| `apps/web/components/wallet-connection.tsx`（新增） | 统一连接/切链/更换账户；激活和审批共用 |
| `apps/web/lib/api.ts`, `types.ts`, `app/actions.ts` | 服务端 cookie 转发、DTO 适配、Server Actions |
| `apps/web/lib/format.ts` | BigInt 小额显示、精确金额 |

共享模块只依赖合适的基础类型；web 不导入 Fastify、数据库、worker 或服务端 Secret 模块。`lib/api.ts` 仍仅供 Server Components/Actions。不要为本功能预先拆整个 monorepo，也不要提前建通用商城 SDK。

## 5. 共享 DTO：冻结的基本字段

以下代码是接口契约，不是要求照抄内部实现。新增代码用 English；保持 strict，不引入 any、星号导入或无必要的类型别名冲突。

```ts
export type ResourceSyncStatus = "syncing" | "ready" | "partial" | "unavailable"
export type PreparationStepState =
  | "waiting"
  | "awaiting_signature"
  | "submitted"
  | "external_pending"
  | "confirmed"
  | "failed"
  | "skipped"

export type PreparationTaskState =
  | "waiting_user"
  | "running"
  | "needs_action"
  | "completed"
  | "canceled"

export interface ResourceRef {
  chainId: 196
  processor: `0x${string}`
  tokenId: string
}

export interface WalletResource {
  resource: ResourceRef
  processorIndex: number
  container: `0x${string}` | null
  owner: `0x${string}` | null
  deployed: boolean | null
  opened: boolean | null
  observedBlock: string | null
  readStatus: "verified" | "unavailable" | "not_found"
}

export interface WalletResourcePage {
  address: `0x${string}`
  chainId: 196
  resources: WalletResource[]
  nextCursor: string | null
  syncStatus: ResourceSyncStatus
  complete: boolean
  indexedThroughBlock: string | null
  observedBlock: string | null
}

export interface PreparationPrice {
  kind: "acquisition" | "open" | "activation" | "service" | "gas"
  currency: "OKB"
  amountWei: string | null
  estimated: boolean
  payer: `0x${string}`
  payee: `0x${string}` | null
}

export interface PreparedStepTransaction {
  intentId: string
  taskId: string
  stepId: string
  quoteId: string
  chainId: 196
  from: `0x${string}`
  to: `0x${string}`
  value: string
  data: `0x${string}`
  gasLimit: string
  gasPriceWei: string
  maxGasCostWei: string
  expiresAt: string
}

export type PreparedStepAction =
  | { kind: "transaction"; transaction: PreparedStepTransaction }
  | {
      kind: "external"
      intentId: string
      taskId: string
      stepId: string
      quoteId: string
      sourceId: string
      externalReference: string
      url: string
      expiresAt: string
    }
```

`null` 只表示未知，不表示 false/零。报价完整对象至少包含 id、userId、recipient、sourceId、offerId/resource、steps、prices、observedBlock、expiresAt、termsVersion。任务响应至少包含 id、state、recipient、chainId、initialQuoteId、currentQuoteId、version、steps、createdAt、updatedAt。

步骤包含 id、ordinal、kind、state、resource/ref、quoteId、intentId、transactions、errorCode、retryable、nextAction。错误以机器码表示，页面本地化解释；不要把任意供应方文本直接当作用户操作指令。

## 6. PostgreSQL 模型与迁移

迁移为增量，编号读取当前最新文件后再分配，不能写死从历史 0014 之后开始。每个 up 有匹配 down；有业务数据时 down 只能作为隔离测试能力，不在生产自动回滚删表。

新表字段使用 snake_case；API camelCase 投影在边界处理。地址用规范化字符串约束，精确金额/token/block 用 numeric(78,0) 或现有合适类型，API 输出字符串。timestamps 为 timestamptz，状态必须有 check 或 enum 约束。

| 表 | 关键字段 | 约束与用途 |
| --- | --- | --- |
| resource_index_checkpoints | chain_id, factory_address, processor_address, through_block, through_block_hash, updated_at | unique(chain_id, processor_address)，记录来源覆盖范围 |
| wallet_resources | chain_id, processor_address, token_id, owner_address, observed_block, observed_block_hash, updated_at | unique(chain_id, processor_address, token_id)，owner 查询索引；公开链投影 |
| resource_quotes | id, user_id, recipient_address, chain_id, source_id, offer_id, resource_snapshot, steps_snapshot, prices_snapshot, observed_block, expires_at, terms_version, created_at | 最终报价不可改写；报价来源不可信数据在创建边界校验 |
| provisioning_tasks | id, user_id, recipient_address, chain_id, initial_quote_id, current_quote_id, idempotency_key, request_digest, state, version, created_at, updated_at | unique(user_id, idempotency_key)，相同键不同请求冲突 |
| provisioning_quote_acceptances | task_id, quote_id, accepted_by, accepted_at | unique(task_id, quote_id)，保存重报价接受记录 |
| provisioning_steps | id, task_id, ordinal, kind, state, quote_id, expected_resource, resolved_resource, external_source_id, external_reference, version, error_code, result, created_at, updated_at | unique(task_id, ordinal)，乐观条件更新；先前步骤完成才进入付费下一步；外部引用和来源联合唯一 |
| provisioning_transactions | id, task_id, step_id, intent_id, chain_id, sender, target, value_wei, calldata, gas_limit, gas_price_wei, max_gas_cost_wei, expected_digest, nonce, tx_hash, replacement_for, status, block_number, block_hash, gas_used, effective_gas_price, created_at, updated_at | tx_hash 可空；unique(chain_id, tx_hash)；FK step/task 一致，意图不可跨任务归因 |
| project_drafts | id, owner_user_id, organization_id, config, preparation_task_id, selected_resource, finalized_project_id, version, created_at, updated_at | 未完成配置可空；只有创建者/合法组织管理员可编辑；配置明确 schema |
| build_attempts | id, project_id, deployment_id, commit_sha, config_version, config_snapshot, retry_of, status, dispatch_ref, workflow_commit_sha, dispatch_correlation_id, workflow_run_id, run_attempt, job_id, html_url, error_code, created_at, updated_at | deployment 唯一映射到一个业务 attempt；GitHub run/attempt 对应约束；源码 SHA 与 workflow SHA 分列 |

正式 projects 增加 `build_enabled` 和 `build_config_version`。历史项目回填为原有启用行为，新正式项目默认 build_enabled=false；草稿不强行插入现有 containerId NOT NULL 的 projects。

现有 `containers_token_id_check` 要求 token_id >= 1，与本规格资源键允许 0 不一致。公开查询支持 0；在确认实际协议是否存在可用 token 0 后，统一解析器、链校验和容器表约束：若实际支持，增量迁移为 >= 0；若协议明确排除，0 可以查询不存在但不可选用。不得仅改前端或无证据把不存在的 NFT 判为可用。加入 tokenId=0 从 inspect 到 finalize 的集成用例。

deployments 增加可空 `recovery_context`（jsonb）：原 planJson 摘要、manifestHash、journal 标识、resumeStage、是否已有链上写入。它只记录跨重签必须保留的恢复上下文，不复制全部 journal；worker 不能只凭当前状态选择是否复用原 plan。

任务幂等摘要覆盖 quoteId、recipient、chain 和准备选项。quote 的价格快照不可覆盖；重报价新增 quote/acceptance，task.current_quote_id 更新，已确认步骤仍关联原报价。所有 confirmed/skipped 与任务汇总状态在同一 DB 事务中更新。

单任务同一步仅允许一个未解决的发送意图；对 version 和 state 作条件更新，重复并发请求返回原意图，不生成第二个付费动作。交易记录不级联清除财务/交付证据。

## 7. HTTP API 契约

### 7.1 共通规则

- 沿用 `/v1`、当前 error envelope 和 requestId。下文是新增目标接口，实施前检查是否与最新代码冲突。
- 身份使用已有 session cookie；输入 userId、wallet 或 projectId 不赋予权限。
- 认证失败 401；已登录但权限不足 403；不可访问任务/项目沿用现有 404 策略；无效格式 400/422；幂等/状态/报价冲突 409；依赖故障 503。
- 写请求在边界校验一次；金额只收非负十进制整数，不收科学计数、浮点和负数。tokenId 允许 0。
- 公共链查询需走专门公开路由分支。当前 app onRequest 默认解析登录，不能只删除 handler 中 requireUser 而声称已经匿名可读。其余路由认证保持原行为。

### 7.2 资源与估价

| Method / path | Auth | 请求 | 响应与行为 |
| --- | --- | --- | --- |
| GET `/v1/resources/processors?chainId=196` | 公共 | 单网络 | processors + sync/observedBlock；目录不带用户所有权 |
| GET `/v1/resources/wallets/:address?chainId=196&cursor=...&limit=20` | 公共 | limit 1–100 | WalletResourcePage；无私有项目/任务字段 |
| POST `/v1/resources/inspect` | 公共 | ResourceRef | 单项 WalletResource，服务端推导容器并读取 owner/deployed/opened |
| GET `/v1/resources/offers?chainId=196` | 公共 | 单网络 | offers、available、unavailableReason；无供应返回空数组，不假装有商品 |
| POST `/v1/resource-quotes/preview` | 公共 | recipient + resource 或 sourceId/offerId + options | 非约束性估价，不创建付费任务；不返回可执行 calldata |
| POST `/v1/resource-quotes` | 登录+钱包已验证 | 与 preview 相同 | 201 `{ quote }`；服务端重新读取与验证，不信任 preview 金额 |

options 首期包含 prepareContainer=true、activateName=false/true、activationMonths、activationName。activateName=true 时必须有实际名称和合法月份，沿用现有名称校验；名称可以由协议规则建议，但必须在报价前显示并由用户确认。实际名称、月份进入报价、任务请求摘要及重报价对比。acquisition 后资产编号才确定的名称，不先构造假名，待解析实际资源后单独确认激活报价。acquisition 与选定已有 resource 互斥；不能两个都收费。公开查询失败不输出 complete=true 的空结果。

最终报价 expiresAt 取供应有效期和平台有效期的较早值；平台建议有效期配置默认 300 秒，这是本规格建议值，可通过配置调整并测试。没有来源可验证价格时不产生可付款报价。

每个可执行步骤保存 maxValueWei 和 maxGasCostWei。首期沿用当前网络已验证的 gasPrice 方式构造 gasLimit/gasPrice，不能只保存一个 UI 上限但发送时完全不使用。超过接受上限需重新确认；用户在钱包中手动修改费用时以其最终签署交易为准，平台不能承诺链上合约会替用户强制该 UI 限额，也不能在超限后伪称原报价内成交。其他手续费机制须确认网络支持后再扩展。

### 7.3 准备任务

| Method / path | 请求 | 响应与约束 |
| --- | --- | --- |
| POST `/v1/preparations` | `{ quoteId }` + Idempotency-Key header | 201 新任务/200 同请求重放；quote 属于当前用户及已验证 recipient；首次接受报价入库 |
| GET `/v1/preparations/:id` | 无 | `{ task }`；仅任务创建用户，首期不自动把任务共享给项目成员 |
| POST `/v1/preparations/:id/requote` | 无或明确准备选项 | 201 新报价供审阅；接收者/chain 固定；只对未完成步骤重新定价 |
| POST `/v1/preparations/:id/accept-quote` | `{ quoteId, expectedVersion }` | 200 task；受理报价修订，不重置已确认步骤 |
| POST `/v1/preparations/:id/steps/:stepId/prepare` | `{ expectedVersion }` | 200 `{ action }`，action 为 PreparedStepAction；先保存意图，再展示钱包或经核验供应跳转；重复请求返回同意图 |
| POST `/v1/preparations/:id/steps/:stepId/transactions` | `{ intentId, txHash }` | 202 `{ task }`，只是登记并排队核验，不能直接 confirmed |
| POST `/v1/preparations/:id/reconcile` | 无 | 202 核验任务；可找回外部已补齐资源，不能自动签名/重发 |
| POST `/v1/preparations/:id/cancel` | `{ expectedVersion }` | 200 task；只取消未发起剩余步骤，submitted/external_pending 未解决时 409 |

prepare 前重新查登录、wallet proof、当前 owner、network、quote expiry、前序步骤、价格及已解决交易。已签交易仍 pending 时不可用 re-quote/cancel 绕过原意图产生第二次收费。

外部 action 在 prepare 时保存 sourceId/externalReference，进入 external_pending；跳转 URL 只能由已核验来源构造。reconcile 通过供应方已验证的服务端查询协议核对订单付款/交付，再结合链上资源验收；浏览器返回页面和 URL 参数不作为成功依据。该来源必须能验证真实支付与交付关系，否则只提供普通外链和外部资源补查，不开放“平台采购已完成”。不要求为所有供应方预建 webhook 框架，有真实回调协议时再按协议实现。

默认外部补齐资源：链上复核后 skip 未执行步骤，并记录 `external_resource_satisfied`；不是平台收款成功。task 完成只表示所需资源就绪。

### 7.4 项目、构建、发布与结果

| Method / path | 请求或结果 |
| --- | --- |
| POST `/v1/project-drafts` | 部分合法配置 → `{ draft }`；可尚无 installation/container |
| PATCH `/v1/project-drafts/:id` | 配置与 expectedVersion → draft，逐字段校验已填写值 |
| POST `/v1/project-drafts/:id/finalize` | expectedVersion → 正式项目；完整准备/installation/owner/配置核验，buildEnabled=false |
| GET `/v1/projects/:id/readiness` | `{ canEnableBuild, canStartBuild, canPublish, checks }`；每项 code/stage/status/reason/nextAction，按 §11 分阶段判断 |
| PATCH `/v1/projects/:id/build-settings` | `{ enabled, expectedConfigVersion }`；写权限，启用需 readiness |
| POST `/v1/projects/:id/builds` | `{ commitSha, configVersion, retryOf? }` + Idempotency-Key → 202 attempt |
| GET `/v1/projects/:id/builds/:attemptId` | run/job/attempt/status/logLink；同项目访问控制 |
| GET `/v1/deployments/:id/capabilities` | approve/execute/reapprove/resume/rollback + 原因及下一动作；由 API 统一计算 |
| POST `/v1/deployments/:id/reapproval` | expectedVersion → 待审批状态/新 payload 可获取；不签名、不自动执行 |
| POST `/v1/deployments/:id/resume` | expectedVersion → 202 继续或明确需要重签；只允许可恢复状态 |
| GET `/v1/projects/:id/publication` | 当前 release、域名绑定/期限、publicUrl、gatewayCheck、checkedAt，各事实分列 |

已有 API 尽量兼容；新增请求不得绕过现有 projectAccess 和安装权限校验。旧页面动作要迁移到新 capability，而不是同时维持两套相互矛盾的角色规则。

## 8. 资源发现的实现要求

1. 读取可信配置中的 Factory，使用 cpuCount/cpuAt 枚举 processor，限制并发；不能从用户输入任意地址扩展可信目录。
2. 通过已验证 Transfer 事件/可信可替换索引源生成候选 NFT。当前 ABI 没有证明 ERC721Enumerable，不得编造 owner 枚举函数。
3. 索引支持 mint、transfer、burn，按日志顺序更新当前 owner；checkpoint 记录区块 hash。RPC 范围限流时分段处理，不将失败分页记为完成。
4. 完整性依赖从部署起点到目标区块的覆盖；扫描起点缺失或供应索引不完整时 complete=false。
5. 选择/报价/执行前，以固定区块重新读取 ownerOf、accountOf、isDeployed、isOpened；processor、推导容器、chainId 必须匹配。
6. ownerOf 的明确不存在与 transport/RPC 故障分别处理。读取失败保持 unavailable，不转换为“未开启”，不追加付费步骤。
7. 私有项目关联单独通过已有访问权限查询；公共结果不能泄露仓库/成员/订单，即使查询地址属于该用户。
8. 索引重启从 checkpoint 继续。规范链发生变化时重新核验受影响区间；不把陈旧快照用于付费决策。

实现先提供 processor + tokenId 手工 inspect，再交付全钱包扫描；尚未完成索引时 UI 必须标记“未完成全量发现”，不能以单项查询冒充全资产列表。

## 9. 准备状态、报价与付款核验

### 9.1 步骤迁移

| 当前状态 | 事件与条件 | 目标状态 |
| --- | --- | --- |
| waiting | 前序 confirmed/skipped 且报价已接受、身份/资源有效 | awaiting_signature |
| waiting/awaiting_signature | 链上已有资源满足，且没有未解决发送意图 | skipped |
| awaiting_signature | 用户拒签或关闭钱包 | 保持 awaiting_signature，记录原因 |
| awaiting_signature | hash 已登记并属于当前意图 | submitted |
| waiting/awaiting_signature | 创建经核验来源的外部购买意图 | external_pending |
| external_pending | 供应端订单和链上交付核验均通过 | confirmed |
| external_pending | 用户返回、供应超时或状态未知 | 保持 external_pending，不重新购买 |
| external_pending | 供应证明确认失败/取消且没有已收费未交付争议 | failed，按来源真实规则处理 |
| submitted | 实际交易、receipt、规范链、交付全部通过 | confirmed |
| submitted | RPC 暂不可见、pending、确认不足、分歧 | 保持 submitted/needs_action，不再次付费 |
| submitted | 确认 reverted 或取消替换 | failed |
| failed | 原尝试已解决，必要时重新报价并明确重试 | awaiting_signature，新增 intent |
| confirmed | 在后续核验发现区块被替换/交付结果失效 | 回到该 action 对应 submitted/external_pending 待复核，暂停下一付费步骤 |

任务汇总：有 submitted/external_pending → running；有需要人工处理的错误/未知发送结果 → needs_action；可签下一步 → waiting_user；全部必要步骤通过且最终资源检查通过 → completed。优先级需一致，出现未知发送结果时不得被 waiting_user 覆盖成“可以再次付款”。

任务 completed 后外部 NFT 转移或域名自然到期，不改写历史交易成功事实；在资源/readiness/publication 中呈现当前不可用。规范链重组与后续主动转移不能混为一谈。

### 9.2 交易验收清单

- 从 chain 读取实际交易，核验 chain/from/to/value/data 对应已保存的意图和接受报价。
- 交易 hash 不得跨任务重复归因为付款；replacement 记录与原 sender/nonce 对应。
- 校验 receipt success、block number/hash、确认深度和该区块仍在规范链；确认策略必须显式配置。没有依据时不猜一个“安全确认数”直接上线采购。
- 固定区块读取目标资源：acquisition 验收供应协议的交付证据及实际 NFT/接收者；open 验收正确电路的 account/open 状态；activation 验收正确名称/容器/期限。
- 两家独立 RPC 一致；分歧保持待核验，不能选一个返回值继续付费。
- receipt success 但无交付、其他钱包交易、历史成功 hash、错误 calldata/value，均不能确认本任务交付。
- 实际 gas 成本记录 `gasUsed × effectiveGasPrice`；与商品转账、service fee、批准 cap 分开，不凭余额差认定所有费用。

### 9.3 价格变化和未确定资产

初始完整准备报价可含后续 gas 估计，但下一实际付费步骤必须已有可执行、有效的精确报价。acquisition 后 tokenId 才确定的，使用 acquisition 结果解析，生成 open 的新报价修订并让用户确认；不得把初始估计当可无限执行的授权。

资源未知时如果激活名称必须从最终编号派生，初始请求 activateName=false，只把未来激活列为后续估计；资源到账后可在原任务的重报价中明确新增 activation 步骤、实际名称和月份。该步骤加入后必须重新接受报价，不生成零地址或占位域名交易；整个准备仍在原任务展示。

重报价只更新未完成步骤，保留原已付款金额、交易和报价。供应方限额、价格、库存或交付地址变化必须明确重审；任务接收地址不可通过重报价更改。

### 9.4 现有域名激活入口也必须修复

operator bind 当前广播→等待 receipt→再入库的顺序需修复。直接钱包 bind 当前拿到 hash 就结束 pending 的路径也要接入同样记录/确认机制。

先创建发送意图；得到 hash 立即保存，再异步核验。广播和数据库不是原子事务，未知窗口采用待核验和找回原交易，不承诺 exactly-once，不自动补发。维护旧 route 的兼容响应时返回 submitted/confirmed 的真实差异，不让旧 UI 把 202 当激活完成。

## 10. 钱包和权限细节

- injected connector 才要求 window.ethereum；WalletConnect 是否可用按 connector 自己的能力和配置判断。
- 统一连接组件至少支持 disconnected、connecting、connected、wrong_chain、wrong_owner、rejected、unavailable。
- 当前容器/审批页可直接连接；不得让用户先去另一个无关页面连接才能激活。
- GitHub 登录后复用已有 `/v1/auth/wallet/challenge` 和 `/verify` 绑定地址；nonce 一次消费、到期规则沿用现有实现。
- 当前 binding.ts 只取一个 verified wallet，应改为查询与当前 owner 匹配的地址。不能使用陈旧 lastObservedOwner 代替执行前链查。
- 容器 owner 与项目操作角色分别判定；组织继承角色复用 projectAccess，不另写只读直接 projectMembers 的审批判断。
- **execute 权限默认保持当前已授权行为**，不借本需求静默收窄 viewer/member 的现有执行资格。若产品另行决定限制为 maintainer/owner，需明确确认并更新角色矩阵；组织继承审批错误可直接修复。
- 准备任务首期归创建者，不因为他人成为项目成员而自动获得采购/收款记录访问权。

## 11. 项目草稿与真实构建闭环

### 11.1 readiness

至少返回 repository_access、installation_active、build_config、static_output、resource_owner、container_opened、path_policy、build_admission 八项。状态为 pass/fail/unknown，每项另有 stage：configuration/build/release。配置可构建与产物可发布分开聚合，返回 canEnableBuild、canStartBuild、canPublish，不能用一个 ready 布尔值替代所有阶段。

canEnableBuild 只要求配置阶段检查通过，不要求 build_enabled 已为 true；canStartBuild 再要求已启用及目标 commit 合法。static_output 第一次构建前允许 unknown，不阻断启用/第一次构建，但必须在发布前验证通过。release 阶段资源/产物 unknown 不允许付费发布。域名未激活不阻断静态构建，但阻断“网站已可访问”的声明。

正式化草稿要重新检查 installation、repository、container 和 user 权限。pathMode 默认 versioned，root 只能在用户已读清覆盖/回滚差异后选择；不能等第一条自动构建开始之后再告知用户策略。

### 11.2 admission 与外部 Actions

草稿/未启用项目：记录 webhook 收到与跳过原因，不创建平台 deployment，不发 build token。平台门禁不能阻止仓库已配置的 push workflow 自行启动，UI 和文档都要准确说明。

首次运行：用户明确选择完整 commit SHA，检查该 SHA 可访问且符合选定仓库/分支策略，然后建立 attempt 和部署 admission。后续推送根据 build_enabled 创建新的业务 attempt；重复 delivery 仍幂等。

### 11.3 构建协议

首期沿用用户仓库 GitHub Actions，不另建通用 runner。须实现/核验支持 dispatch 的 workflow，checkout 精确 SHA；workflow 使用平台保存的 configVersion/configSnapshot，不能控制台写一套、实际 workflow 固定 npm ci 跑另一套。

最少新增以下协议能力：

- POST `/v1/builds/context`：OIDC → 获准 attempt 的构建配置和确定 commit；与既有 token 交换统一关联逻辑。
- POST `/v1/builds/events`：OIDC 认证的 run/job/attempt started/failed/succeeded，按事件幂等；客户端提交的 projectId 不作认证依据。
- 既有 `/v1/builds/token` 和 artifact 上传扩展 attempt 关联，保留一次性 token 和 repository/ref/sha 绑定。

GitHub run_id/run_attempt 与 workflow 身份、repository/ref/sha 的 claims 必须实际核验。若依赖当前 verifier 未暴露字段，在现有 OIDC 模块扩展并测；不能从不可信请求 body 认定 run 身份。配置获取要在 install/build 之前，失败回报用 workflow `always()` 路径或已验证 run 事件补齐，避免安装失败永久停在 RECEIVED。

dispatch 必须分开保存 workflowCommitSha（实际运行 workflow 的版本）与 commitSha（目标源码版本）。OIDC sha 不直接认定为 checkout 产物 SHA。平台先保存含 target SHA/configVersion 的 attempt 和 dispatchCorrelationId，dispatch 到已验证 workflow/ref 并传入关联标识；通过已认证 GitHub run API 和 OIDC 核对仓库、workflow 身份/版本、runId/runAttempt。关联标识不单独作为认证凭据，不能被任意 body 的 targetSha 改写。

build context 只返回服务器已保存且已授权的目标 SHA/config，受信的工作流必须显式 checkout 该 SHA；artifact 绑定同一个 attempt。选择分支历史 SHA 时，workflow 当前版本与目标源码 SHA 不同是合法情况，按两种身份分别核验。该机制证明构建关联与既定工作流执行约定，不宣称产物有密码学可证明构建。验收包括历史 SHA、伪造关联/targetSha 和不匹配 workflow 版本。

同 SHA 重试新建 attempt，并保留 retry_of/configSnapshot；不能直接重放 webhook，因为现有 sourceEventKey 幂等会复用旧部署。重复 dispatch 请求以 Idempotency-Key 防重，调用 GitHub 结果未知时先核对 run，不自动循环 dispatch。

日志首期提供已授权 run/job 链接和失败步骤，不强制下载并存储完整日志。平台展示日志内容时沿用 secret 屏蔽与访问控制；不在 UI 明文输出安装 token、OIDC token 或环境 Secret。

## 12. 发布重签、中断恢复和站点结果

### 12.1 审批摘要

加载实际 payload → 显示摘要 → 用户确认 → 对同一 payload 调用钱包签名 → 提交 API。摘要包含 deploymentId、commit、manifestHash、container、chain、verifyingContract、signer、costCapWei、expiresAt 和费用说明。

账户、chain、payload expiry 或计划变更后，清空旧确认并重新加载；不能先展示 A 再后台取 B 去签。人工签名回退保留同样复核。

### 12.2 reapproval

当前 APPROVED 无有效 approval、APPROVAL_EXPIRED 等可修复情形，要有明确 reapproval 入口。服务端重新检查当前项目角色、owner、计划摘要、预算和实现版本；撤销旧授权、生成新 nonce，按状态迁移回 AWAITING_APPROVAL。

保持原批准计划可恢复时使用原计划，不随意从“当前链状态”重算成另一个隐式计划；原计划已失效或 manifest 改变时创建新的部署尝试，清楚说明不能沿用旧签名。

上传已有写入后再重签，必须在 deployments.recovery_context 保留原计划摘要、journal 标识和恢复阶段，跨 AWAITING_APPROVAL → APPROVED 不丢失。现有 worker 仅在当前状态是 UPLOAD_INTERRUPTED 时复用 planJson，重签后必须改为优先检查有效恢复上下文；否则会重新规划半写入资源并发生 UPLOAD_CONFLICT。新增“部分 chunk 已写→授权过期→重签→APPROVED→恢复”集成测试，验证原计划和 journal 继续生效、无重复写入。

### 12.3 resume

UPLOAD_INTERRUPTED 已有 worker/journal 恢复基础。新增 public resume 入口接通它，核对原 pending/receipt、chunk 索引、计划和有效授权，然后继续未完成写入。授权过期则先重签，不跳过签名门禁。

VERIFY_FAILED、SWITCH_FAILED、RPC_DISAGREEMENT 等不能一概增加“重试”按钮；按已有状态机和实际可恢复证据决定 capability。未核验恢复路径显示明确阻塞，不改成无限自动重试。

### 12.4 publication summary

返回 release（当前）、binding（状态/名称/paidUntil）、publicUrl、gatewayCheck（unknown/checking/reachable/unreachable）、checkedAt。URL 从可信网关和协议名称构造，不接收任意 URL 让后端探测。

HTTP bootstrap/service-worker 模式沿用已有网关验证事实，不能仅拿根 HTML hash 与链上站点 hash 比较。链上 release verified、域名 active、网关 reachable 各自呈现；历史部署 LIVE 不冒充当前版本。

## 13. 错误码、金额和配置

新增错误至少覆盖下列语义；复用已有相同语义的机器码，避免重复：

| 类别 | 示例机器码 | 用户恢复动作 |
| --- | --- | --- |
| 发现 | RESOURCE_READ_UNAVAILABLE、RESOURCE_INDEX_PARTIAL | 刷新/手工补查，不引导重复购买 |
| 钱包 | WALLET_VERIFICATION_REQUIRED、WALLET_MISMATCH、WRONG_CHAIN、OWNER_REQUIRED | 验证/切回钱包/切链 |
| 供应 | SOURCE_UNAVAILABLE、OFFER_UNAVAILABLE | 查看原因、选已有资产或其他已验证来源 |
| 报价 | QUOTE_EXPIRED、QUOTE_CHANGED | 重报价并审阅，已完成步骤保留 |
| 幂等 | IDEMPOTENCY_CONFLICT、STEP_VERSION_CONFLICT | 载入已有任务/最新状态 |
| 交易 | TRANSACTION_UNRESOLVED、TRANSACTION_MISMATCH、DELIVERY_UNVERIFIED | 核验原交易，禁止自动重复付费 |
| 构建 | BUILD_DISABLED、BUILD_CONFIG_CHANGED、WORKFLOW_UNAVAILABLE | 完成准备/刷新配置/修复 workflow |
| 发布 | APPROVAL_EXPIRED、RPC_DISAGREEMENT 等已有错误 | 重签/核验/按服务端 capability 恢复 |

所有非零金额必须可区分于零；1 wei 也不能格式化为 0.0000 OKB。unknown 显示未估算；gas 估计不标实际已花费；cap 不标已收费。预算输入显示单位并精确换算，禁止 Number 浮点作为付款依据。

新增配置通过现有 env 模块验证：采购开关、可用 source 配置、报价时效、索引起点/批量限制、准备交易确认策略。默认采购关闭，无来源目录返回 unavailable；缺确认策略不开放交易 confirmed 判定。不得把测试合约或 fork RPC 放进真实采购配置。

## 14. 开发阶段、交付与并行顺序

沿用前计划 T00–T11，下面规定每阶段可验收产物，避免 DeepSeek 一次性生成所有页面后声称完成。

| 阶段 | 工作与明确完成条件 | 可并行 |
| --- | --- | --- |
| P0 基线与契约 | 复核工作区、15 项问题，确认分支/工具；共享 DTO 和 API 评审；真实供应缺口登记 | 主代理集中完成 |
| P1 基础修复 | WalletConnect/多地址/RPC false/费用精度/有效角色修复，目标回归通过 | 钱包、链状态、费用三组 |
| P2 发现与持久化 | inspect→索引→公开查询；独立准备 schema、意图和核验任务；跨用户及重启通过 | 发现和准备数据组，schema 串行集成 |
| P3 已有电路开启 | 报价→钱包→pending→确认→进入项目；fork 和重启可恢复 | 依赖 P1/P2 |
| P4 草稿和真实构建 | 未启用不 admission；config 确实驱动 workflow；失败/重试有新 attempt | 可与 P3 并行 |
| P5 采购来源 | 一家真实来源完成 sandbox/fork 验收；否则入口关闭并报告 blocked | 等来源材料，不阻断 P3/P4 |
| P6 发布和 UI 集成 | 同 payload 摘要、重签/resume、当前站点结果；旧功能不丢失 | 服务端先契约、UI 后接入 |
| P7 独立验收 | 全流程矩阵、设备/真实集成分别记证据，不用 Mock 代替 | 未参与实现的 reviewer |

共享 `schema.ts`、migration 编号、app 注册、shared index、i18n 和全局 CSS 由集成人统一负责。Agent 各自任务结束交接接口、文件、测试、未验证事实；不得同时改同一块代码而不协调。

首期可上线的最小结果：已有电路发现/选择/开启 + 项目构建发布闭环。无真实供应材料不阻止交付该结果，但不能宣称“完整购买流程已完成”。

## 15. 测试清单与证据要求

### 15.1 具体测试文件

| 文件（新增或扩展） | 必须验证 |
| --- | --- |
| `tests/p2/web/wallet-connectors.test.ts` | 无 ethereum 的 WalletConnect；注入钱包缺失；连接错误可恢复 |
| `tests/p2/api/container-bind.test.ts` | A/B 多地址、所有者转移、原绑定入口 pending/确认 |
| `tests/unit/resource-discovery.test.ts` | false/not_found/unavailable、tokenId=0/大整数、分组和分页 |
| `tests/p2/api/resources.test.ts` | 匿名资源、私有字段不泄露、部分扫描不假空、传入他人地址不越权、tokenId=0 全链路约束一致 |
| `tests/unit/fee-display.test.ts` | 0、1 wei、99999999999999、100000000000000、超 Number 安全整数、null |
| `tests/p2/provisioning/persistence.test.ts` | 同键并发、不同请求冲突、重连、restart、跨用户读取拒绝 |
| `tests/p2/provisioning/transactions.test.ts` | hash 登记非完成、超时不重付、replacement/cancel、历史 hash、错误 value/data、区块变化 |
| `tests/p2/provisioning/open.test.ts` | 已开跳过、未开仅 open、转移后拒绝、报价变化和部分成功恢复 |
| `tests/p2/provisioning/provider-contract.test.ts` | 无来源 unavailable、真实来源交付契约、错误接收者、库存遗留授权、external_pending 返回页面不算成功 |
| `tests/p2/api/project-drafts.test.ts` | 无容器保存、CAS、finalize 幂等、旧项目兼容、新项目未启用、全新项目无 static_output 仍能首次启用 |
| `tests/p2/github/build-runs.test.ts` | start/fail 回报、确定 SHA/config、OIDC run 关联、同 SHA 新 attempt、重复 callback、历史 checkout SHA 与 workflow SHA 区分 |
| 现有 queue/API approval 测试 | 组织继承权限、过期重签、旧 nonce 失效、部分 chunk 后跨重签回 APPROVED 仍按原计划/journal 恢复 |
| web e2e 新资源/任务/构建场景 | 从 UI 完成已有资源流程；状态不跳步；入口无丢失 |

测试调用实际实现；优先隔离 PG/真实 fork，不把实现复制到测试，不用 globalThis 随意替换。无设备、无 fork、无供应 source 时明确 skip 原因；skip 不能当通过。

### 15.2 测试命令规则

当前仓库是 pnpm workspace/Vitest，不是用户规则示例中的 opencode。不得运行不存在的命令或安装一个新工具链来掩盖差异。

1. 开始先确认根 package.json、Bun、依赖锁定和 `.opencode/skills` 是否实际存在；匹配测试 skill 存在则先读，缺失记录。
2. 用户要求测试从包目录运行。先验证包目录 Vitest 的发现配置；确认命令实际列出目标测试，再执行。示例是候选命令，未经验证不能记已通过：

```bash
cd /Users/a77/Desktop/tapeout/apps/api
bun x vitest list --root ../.. --config ../../vitest.config.ts tests/p2/provisioning
bun x vitest run --root ../.. --config ../../vitest.config.ts tests/p2/provisioning
```

3. 若 --root/配置解析不兼容，增加最小包本地 test 配置和脚本，记录最终命令；不能以“0 tests”结束验收。
4. 根当前没有 `check` 时，先增加兼容现有 lint/typecheck/web 的 canonical 包装，再执行用户要求的 `bun run check`；不直接调用 tsc。不要无意把 Next 专属配置排除出 web 检查。
5. Next 修改前阅读安装版本本地文档。当前不存在 Protocol/Server HttpApi 和 packages/client 时不执行不存在的 generate；若未来涉及实际生成客户端，按用户规则运行生成，不手改产物。
6. PG 重启测试创建独立实例/volume，不停止现有共享服务；迁移只对隔离数据库执行。全量测试需要哪些网络/容器条件必须列出。

### 15.3 端到端发布门槛

- E01：已有已开启电路，无采购完成发布。
- E02：已有电路只补齐开启，发布成功。
- E03：无资产→真实供应→交付核验→开启→项目→发布；供应缺失则标 blocked。
- E04：查询他人地址、跨用户/项目请求不得获得私有数据或付费能力。
- E05：购买成功、开启失败，刷新及 API/worker 重启后不重复购买。
- E06：钱包切换、报价过期、拒签、余额不足和 pending 状态可解释且可恢复。
- E07：草稿收到 push/OIDC 不 admission，启用后只构建选择的 SHA，控制台配置实际生效。
- E08：真实构建缺包失败可见失败步骤，重试产生新 attempt，重复 webhook 不重复创建。
- E09：审批过期重签、上传中断继续、不重复 chunk，原权限/预算/验证门禁仍有效。
- E10：LIVE 未激活、激活网关失败、历史非当前版本分别显示，访问成功有时点与依据。
- E11：390/1440、中英文、键盘、axe 与原功能回归。
- E12：注入钱包、WalletConnect 手机、硬件宿主桥接分别留真实证据；不能用一个 EOA 签名替代三种设备验收。

每个场景记录 commit、配置、运行时间、命令、结果、日志/截图路径；链场景附 fork block 或公开 tx/receipt/核验摘要。证据不存 Secret。最终报告区分静态审查、本地/fork 通过、真实通过和外部阻塞。

## 16. DeepSeek 每阶段交付格式与最终定义

每阶段输出：

1. 已完成需求/任务 ID，以及本次具体行为变化。
2. 修改文件及接口/迁移兼容性；不以大量文件替代结果说明。
3. 实际执行的测试命令、通过/失败/跳过数量及必要日志。
4. 未完成项目、真实依赖、下一阶段可以继续的工作。
5. 与本文偏差及理由；涉及资金、权限、公开 API 或数据语义变化先说明，不静默扩大范围。

最终完成必须满足：需求有实现或明确受控不可用；已有资源完整路径通过；采购若开启则有真实来源及可靠交付核验；工作区原功能无回退；数据库/状态/权限测试通过；真实外部验收如未完成则清楚报告。不能因页面看起来完整、Mock 演示流畅或某条 receipt success 就称全功能完成。

## 17. 可直接发给 DeepSeek 的启动指令

必须启动 subagent 协作模式，由主代理协调产品、开发、测试三个角色共同推进。产品持续核对真实流程和功能保留，开发按契约实现，测试从任务开始即准备验收并随实现执行；不等所有代码完成后才开始测试。

```text
Read docs/superpowers/specs/2026-10-27-deepseek-development-spec.md first.
Use it with the linked product design and implementation plan.
Inspect the current repository and uncommitted changes before editing.
Do not overwrite existing UI work or assume historical findings are still unfixed.

Start subagent-driven development. The main agent must coordinate three distinct
subagents: Product, Development, and Test. Keep them involved throughout each phase.
Do not silently replace this team with a single-agent implementation. If the
runtime cannot spawn subagents, report that limitation before claiming this
execution mode is active.

Main agent responsibilities:
- Own the task board, dependencies, interface decisions, integration, and progress.
- Give each subagent a bounded task, relevant spec sections, file ownership,
  dependencies, expected deliverables, and acceptance criteria.
- Maintain one shared issue log with requirement ID, evidence, severity, owner,
  status, and verification result. Add confirmed findings to the development plan.
- Integrate shared schemas, migrations, route registration, translations, and
  global styles serially. Do not let agents overwrite each other's work.
- Resolve ordinary implementation choices within this spec. Escalate only
  decisions that materially change product scope, payments, permissions, or APIs.

Product subagent responsibilities:
- Before each task, check the user journey, acceptance criteria, UI states, and
  preservation of existing features against the spec and current implementation.
- Clarify behavior and identify missing steps, contradictory states, or scope drift.
- Review the working result during development and verify the complete journey
  at phase completion. Product review does not replace technical tests.

Development subagent responsibilities:
- Implement small, reviewable tasks using the agreed contracts and existing modules.
- Add focused developer tests and hand off changed files, interface or migration
  changes, actual verification results, and known limitations to the Test subagent.
- Fix verified defects and return them for retest. Do not mark a task accepted
  solely because the implementation is finished or developer tests pass.
- Additional development subagents may work on independent modules when capacity
  permits, with explicit file ownership and integration boundaries.

Test subagent responsibilities:
- Start alongside Product and Development: inspect existing tests and prepare
  acceptance cases, fixtures, and isolated test environments before code is ready.
- Run integration, failure-recovery, permission, persistence, UI, and regression
  checks as each deliverable becomes available. Follow the spec's test rules.
- Record reproducible failures with expected versus actual behavior and evidence;
  send them back for fixes, then rerun the affected checks.
- Independently verify the integrated phase result. Distinguish mock, local,
  fork, and real integration evidence. Never report unrun or skipped tests as pass.

Implement in the P0-P7 order. Start with baseline, shared contracts, and the
existing-resource path. Keep purchase unavailable until a real provider is verified.
Work in parallel where dependencies allow: Product reviews upcoming behavior,
Development implements the current task, and Test prepares or verifies available
deliverables. Keep dependent mutations and shared-file integration sequential.

For every task, follow this loop:
1. Product confirms the behavior and acceptance criteria within the approved scope.
2. Development and Test agree on contracts, test cases, and test environment needs.
3. Development implements while Product reviews flows and Test prepares checks.
4. Test verifies the deliverable; Development fixes failures; Test retests.
5. Product checks the user journey and feature preservation. The main agent marks
   the task accepted only when required checks pass and no blocking issue remains.
   External dependencies must remain explicitly blocked, not accepted as complete.

At each phase boundary, verify the integrated result and update the task board,
issue log, development plan, and evidence index. At P7, use a Test or reviewer
subagent that did not implement the reviewed changes for independent acceptance.

Preserve all existing features. Reuse the current deployment engine and journal.
Do not invent purchase ABIs, claim mock results as real evidence, hold the user's
private key, send mainnet payments, widen GitHub permissions, commit, push, or
deploy without explicit authorization for those actions.

For each phase, report changed files, implemented requirement IDs, actual test
commands and results, remaining dependencies, and deviations from the spec.
Include each subagent's assignment and status, Product review results, Test
acceptance results, and unresolved issues with their owners and next actions.
Continue independent authorized work when a provider, device, or live credential
is missing. Ask only when the missing decision actually blocks correctness.
```

## 18. 交接文档审查记录

本文经采购持久化和构建发布两个独立 Agent 只读审查后修订，补齐：实际激活名称、tokenId=0 与现有约束的统一、外部采购 action/等待/验收、首次构建的分阶段 readiness、workflow SHA 与目标源码 SHA 的区分，以及重签后的原计划/journal 恢复上下文。

与旧计划的执行角色建议不同，本文明确默认保留现有 execute 权限，不以修复名义静默收窄。首次启用不要求 static_output 已被构建验证；该检查属于发布门禁。供应来源、确认深度和真实设备/付款仍须实际落实，文档审查不能代替运行时验收。
