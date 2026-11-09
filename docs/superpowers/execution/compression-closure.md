# 压缩发布线 — 收尾

**状态：SPEC 定义的全部四个阶段（A / B / C1–C4 / D）已实现并合并。默认关闭，不具备生产条件。**

本文档记录这条线做了什么、证明了什么、复审发现了什么、以及还欠什么。它替代不了各阶段的
证据报告，但能让后来的人不必从 10 份报告和 12 个提交里重建结论。

---

## 1. 这条线要解决什么

TapeCI 原本把静态站点按文件逐个上链：每个文件一次或多次交易。一个中等站点可能有几十个
文件，每一笔都要付 gas。

压缩发布把整个站点打包成**内容寻址的压缩包**：一个入口描述符、一个包索引、若干存储对象。
链上写入次数和字节数都下降。

关键约束（全部来自 SPEC）：

- **Manifest v1 不能改**（`packages/artifact` 拒绝未知字段）；
- 原有的发布、审批、恢复、回滚**一条都不能丢**；
- **已审批的字节永远不能重新压缩**；
- 原始发布保持默认，压缩是显式选择；
- 没有主网写入、没有付费 Actions、没有自动发布。

---

## 2. 四个阶段

| 阶段 | 交付 | 关键文件 |
| --- | --- | --- |
| **A** | 离线分析器：四种候选策略、验证解码、包索引、与上次分析对比、CLI、本地证据 | `packages/compression/src/*`（924 行） |
| **B** | 浏览器/网关的显式 pack-resolver 钩子；本地预览用独立 loopback origin，不替换线上 TapeKit worker | `browser.ts`, `gateway.ts`, `preview.ts` |
| **C1** | `prepareCompressedRelease` 保留 Manifest v1；`sourceArtifactDigest` 与 `artifactDigest` 分离，后者覆盖全部物理字节并派生 release ID | `packages/release/src/compressed.ts` |
| **C2** | Worker 在审批前冻结确定性内容寻址 tar；计划、执行、验证、重签、回滚全部复用该快照；迁移 `0020` | `apps/api/src/worker/prepared-artifact.ts` 等（408 行） |
| **C3** | 显式策略选择 + 本地化审阅面板；`GET`/`POST /v1/deployments/:id/preparation` 创建独立 BUILT 尝试 | `routes/deployment-preparation.ts`, `compression-preparation-panel.tsx` |
| **C4** | 同状态 fork 基准：每个候选前恢复同一基线，真实 TapeKit 内核读链上字节并核对物理/逻辑一致性 | `tests/fork/compression-measurement.test.ts` |
| **D** | `selectReleaseStrategy` 把 §15 变成显式可测规则；面板展示已记录计划的成本行与选择理由 | `packages/deployer/src/comparison.ts`, 面板 |

### 四种策略

| 策略 | 物理文件 | 物理字节 | 链上交易 | 实测 gas |
| --- | ---: | ---: | ---: | ---: |
| original | 4 | 45,477 | 5 | 11,331,376 |
| gzip-individual | 6 | 26,959 | 7 | 8,103,132 |
| **gzip-whole** | 3 | 26,408 | 4 | **6,910,884** |
| gzip-grouped | 5 | 26,710 | 6 | 7,691,472 |

**这些数字的边界必须一起读**：源是 45,409 字节的**合成 fixture**（4 个文件），不是真实项目。
它证明的是「同一状态下可以比较完整计划」，**不是**「压缩能省 X%」。真实收益取决于站点结构、
增量更新、对象复用和布局。

`gzip-individual` 减少字节但**增加**交易数——单个文件的压缩包反而更贵。这正是必须比较完整
计划而不是只看体积的原因。

---

## 3. 复审：这条线最有价值的部分

### 三轮，全部由未参与实现的 reviewer 完成

| 轮次 | 范围 | 判定 | 发现 |
| --- | --- | --- | --- |
| 1 | 全量 5 个高风险区 | trustworthy-with-fixes | 4 × P1 + 5 × P2 |
| 2 | 复审已提交的树 | **fix first** | 6 项修复里 **3 项只做了一半** |
| 3 | 定向复审 3 项残留 | **residuals closed** | 三项全闭，且确认测试在回退后会失败 |

报告：[`stage-c-review`](../research/compression/stage-c-review-2026-10-29.md)、
[`stage-c-rereview`](../research/compression/stage-c-rereview-2026-10-29.md)、
[`stage-c-rereview2`](../research/compression/stage-c-rereview2-2026-10-29.md)。

### 复审抓到的 P1（都已修）

| 缺陷 | 后果 |
| --- | --- |
| 压缩记录在规划阶段外、pin 与 manifest 皆 NULL 时**回落源码重建** | 会发布没人审批过的字节 |
| 回滚对缺失 pin 的压缩发布返回 **202**，之后异步失败 | 调用方轮询一个永远不可能成功的部署 |
| 快照的 `artifactDigest` **只做格式校验**，从不按自身行重算 | 探针冻结了一个 `0x000…` 的摘要并被接受，而物理行哈希是 `0x43ff…` |
| `0020` down 迁移**无备份删掉 pin** | 压缩发布永久无法恢复 |

### 复审抓到的「修复不完整」（第 2 轮）

这一轮最值得记录，因为它是**对我自己修复的复审**：

| 我声称修好 | 实际 |
| --- | --- |
| F3 快照不再依赖 raw key | 只修了加载路径，**回滚路由仍先解析 raw key 并抛 `ARTIFACT_UNAVAILABLE`** |
| F4 加了聚合上限 | 64 MB 绝对上限仍允许「64MB 存储、8 字节解码」的索引 |
| F1 摘要已重算 | 只重算了 `artifactDigest`；`sourceArtifactDigest` 仍只做格式校验，且压缩模式会**静默回退到物理摘要** |

共同模式：**修了主路径就宣称闭合，没检查同族的其它入口。**

### 为什么这轮复审值得

三轮里，第一轮发现 4 个 P1，第二轮发现我 3 项修复做浅，第三轮才确认收敛。
**如果不做第 2、3 轮，前两类问题会直接进 main。**

---

## 4. 安全边界（实际守住的）

| 边界 | 状态 |
| --- | --- |
| 已审批字节不得重压缩 | ✅ 压缩记录在规划阶段外拒绝从源码准备 |
| 新尝试不继承权限 | ✅ C3 的 INSERT 不复制 approval / pin / plan / journal（复审逐列核对） |
| 审批绑定物理字节 | ✅ 签的是 `manifestSha256`/`releaseManifestHash` |
| 解压有界 | ✅ 64 MiB 解码上限 + `maxOutputLength` + 已存字节与解码字节挂钩 |
| 自动选择默认 original | ✅ 规则存在但生产门禁关闭 |
| 无主网写入 | ✅ 全部 fork / loopback |

### 已知的 P3（记录，不影响字节正确性）

- 直接调用 `freezePreparedArtifact` 可绕过 source digest 要求（生产路径不这么用）；
- `preparation_request` 为 NULL 的旧压缩行会被解析为 original，**失败关闭**但错误码是通用 `PLAN_STALE`；
- `MAX_STORED_BYTES` 在 `parsePackIndex` 中已被比例规则覆盖，但 `parsePreviousAnalysis` 仍需它。

---

## 5. 验收数字

在干净检出的 `main` 上：

| 检查 | 结果 |
| --- | --- |
| `pnpm check`（lint + typecheck + web） | exit 0 |
| unit | **630** |
| p2（真实 PostgreSQL） | **423** |
| e2e | **152 passed / 1 skipped** |
| 压缩相关单测 | **60**（7 个文件） |
| **完整 fork 套件**（`TAPECI_COMPRESSION_FORK=1`） | **65 passed / 1 skipped** |
| C4 测量测试 | 1 passed（162.7 s，数字与报告一致） |

那 1 个 skip 是 C4 的测量测试在未设置 `TAPECI_COMPRESSION_MEASURE=1` 时的默认行为——它
需要显式环境变量才会执行真实 fork 写入，这是刻意的，不是遗漏。

C4 的复现命令：

```bash
PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$PATH" \
TAPECI_COMPRESSION_MEASURE=1 \
TAPECI_TAPEKIT_SOURCE=/private/tmp/tapeci-tapekit-compression-20261028 \
  pnpm exec vitest run tests/fork/compression-measurement.test.ts
```

> 注意：`TAPECI_TAPEKIT_SOURCE` 需要一个 pinned TapeKit 检出，且 `bun` 必须在 PATH 上。
> 缺任一项，测试会失败——这不是测试坏了，是环境没准备。

---

## 6. 还欠什么

### 生产门禁（全部需要外部条件）

| 项 | 为什么现在做不了 |
| --- | --- |
| 生产网关资格认证 | 没有真实部署的网关；C4 是本地 fork |
| 生产兼容交易模拟 | 需要有真实费用数据才能给跨策略报价 |
| 迁移 `0020` 应用到持久环境 | 运维动作 |
| Cloudflare / 付费域名 / Service Worker 生命周期 | 外部基础设施 |
| 独立 RPC 运营方、主网费用核算 | 需要真钱验证 |

### 代码层面的已知限制

| 项 | 说明 |
| --- | --- |
| `compareReleaseCosts` 无生产调用方 | 库已实现并测试，但没有任何 API/worker/console 路径调用它。C2 附录原写「完整计划比较」，已改为「库仅此而已」 |
| 压缩「归档缺失」场景无直接测试 | 共享路径有测试，压缩专属场景没有 |
| 原始模式 `artifactDigest` ≠ 计划 `artifactDigest` | 既有问题（入口改写），不影响审批 |

---

## 7. 这条线不声称什么

- **不声称压缩能省钱。** C4 是一个 45 KB 合成 fixture 的测量，不是真实项目基准，也不承诺任何百分比。
- **不声称已生产可用。** 默认关闭，无网关资格，无生产模拟。
- **不声称自动选择可用。** 规则存在、被测试，但在生产参数下恒定返回 `original`。
- **不声称替代原始发布。** 原始模式仍是默认，且是唯一不需要外部网关的模式。

---

## 8. 如果要真的启用，顺序是什么

1. 部署并**资格认证**一个网关（`TAPECI_COMPRESSION_GATEWAYS_JSON` 填真实 profile）；
2. 用真实费用数据做**生产兼容的交易模拟**，把 `productionSimulation` 置为可用；
3. 在真实项目上跑一次 C4 同类的测量，确认完整计划确实更便宜；
4. 在持久环境应用迁移 `0020`；
5. 才考虑把自动选择从 `original` 放开——即便如此，SPEC §15 要求「严格更便宜」且全部门禁通过。

**在此之前，压缩功能对用户不可见。**
