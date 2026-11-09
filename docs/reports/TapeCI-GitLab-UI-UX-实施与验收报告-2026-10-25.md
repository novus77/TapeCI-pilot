# TapeCI GitLab UI/UX 实施与验收报告

日期：2026-10-25  
分支：`codex/gitlab-ui-ux`  
基线：`6be8715`  
状态：本地实施与独立验收完成，改动未提交、未推送、未部署

## 结论

TapeCI 控制台已从原有深色、装饰性较强的界面，迁移为以 GitLab 产品结构和 Pajamas
组件语义为基准的浅色发布控制台。改版覆盖首页、项目、部署、容器、组织、审计、
Webhook、设置、比较、登录、错误和加载状态，同时保留原有 API、路由、权限、状态机、
链上证据、手动签名与发布安全门禁。

本轮还修复了独立审查发现的移动端功能回归：390px 视口下语言切换曾被全部隐藏，
最近部署表又被压缩到难以阅读。当前版本在手机顶栏保留紧凑语言入口，并让宽表只在
可聚焦的表格容器内横向滚动。页面级横向溢出为零。

首轮独立监督还定位出三个可复现问题：里程碑文字因祖先 `opacity` 降至 3.16–3.33:1、
首页项目区沿用了“查看全部部署”的错误文案、Mock 提示写死项目数量。三项均已修复。
浅色警告块中残留的暗色主题黄色文字也一并修正。最终在全新生产构建和全新 3103
Mock 进程上通过全部 84 项浏览器验收。

功能保全是本次改版的硬约束。内容从首屏移入标签页、折叠区或次级入口时，原数据、
原始状态和操作仍可访问；按状态隐藏无关操作不等于删除能力。所有钱包、预算、
所有权、审批有效期、并发锁和服务器端安全检查仍由原有业务层执行。

## 设计对齐

本次以 GitLab 实际产品层级和官方 Pajamas 为唯一主要标杆：

- 深色顶栏、浅色内容面、固定左侧导航和项目上下文。
- 14px 正文、12px 元信息、4px 组件圆角、紧凑表格和紫色主操作。
- Badge 表达状态，Alert 表达当前条件与恢复路径，Tabs 分隔同一部署的不同证据。
- 阶段图表达 Build Success、Uploaded、Verified、Live，审批作为额外门禁展示。
- 表单采用单列任务组织、字段级错误和明确下一步。

实现沿用现有 Next.js、React、TypeScript、Lucide、Radix、Vitest、Playwright 和 axe，
没有引入新的 UI 框架或依赖。GitLab 是设计基准，不声称当前界面与某个 GitLab
发行版像素级一致。

设计依据：

- [Pajamas](https://design.gitlab.com/)
- [Layout](https://design.gitlab.com/product-foundations/layout/)
- [Type fundamentals](https://design.gitlab.com/product-foundations/type-fundamentals/)
- [Button](https://design.gitlab.com/components/button/)
- [Badge](https://design.gitlab.com/components/badge/)
- [Table](https://design.gitlab.com/components/table/)
- [Tabs](https://design.gitlab.com/components/tabs/)
- [Alert](https://design.gitlab.com/components/alert/)
- [Forms](https://design.gitlab.com/patterns/forms/)
- [GitLab CI/CD pipelines](https://docs.gitlab.com/ci/pipelines/)

## 信息架构

首页现在首先回答“有哪些项目、当前版本是什么、最近一次部署是什么、哪些需要处理”：

- `/` 展示项目摘要、当前版本、最近部署、限定范围的统计和最近部署快照。
- `/projects` 提供可发现的完整项目列表，不再要求用户从历史记录中寻找项目。
- `/projects/:id` 区分当前版本与最近一次部署，失败的最新尝试不会抹掉当前版本。
- `/deployments/:id` 先呈现结果、阶段和相关操作，再通过 URL 分区查看概览、文件、
  交易、验证和事件。
- 容器、组织、设置、审计、Webhook、比较和登录页面沿用同一应用壳层与组件层级。

统计和筛选使用同一快照谓词。首页明确显示“最近 N 条部署”，搜索结果也明确只覆盖
已获取记录；未实现的服务端全量搜索没有被包装成完整历史检索。历史 LIVE 记录只表示
快照中曾完成的部署，不被描述成多个当前在线站点。

## 关键体验修正

| 问题 | 当前处理 |
|---|---|
| 无独立 Projects 入口 | 增加 `/projects`、侧栏入口和项目摘要组件 |
| 最新部署失败可能遮住当前版本 | 项目卡和项目详情并列展示当前版本与最近部署 |
| 历史 LIVE 被误解为当前在线站点 | 统计明确限定为最近部署快照 |
| Attention 数字与链接筛选不一致 | 计数与链接共用同一 attention 谓词 |
| 搜索范围不明确 | 页面显示已获取记录数与 limit，提示更早结果可能存在 |
| 部署详情先显示大量技术信息 | 结果、里程碑、相关操作优先，证据移入 URL 分区 |
| LIVE 页面仍显示钱包缺失警告 | 钱包和签名控件只在可审批状态渲染 |
| 失败状态提供看似可重试的动作 | 不提供无条件重试，保留真实阻断原因与恢复说明 |
| 域名激活被等同于发布 LIVE | 域名作为独立容器状态，未知不渲染为正常 |
| 新建项目缺少路径配置提示 | 保留完整创建字段并明确交接至 Settings，未擅改 API |
| 中文页面残留英文操作与错误 | 补充本轮触及页面的 EN/ZH 字典和无障碍名称 |
| CSS 覆盖层过重 | 从约 5,346 行收敛到约 3,500 行语义化样式 |
| 手机无语言切换入口 | 顶栏保留紧凑 `EN / 中` 切换，完整文案在窄屏隐藏 |
| 手机表格列被压成窄条 | 表格在 `.table-wrap` 内保持 660px，由容器滚动 |
| 加载态固定英文 | 改为随当前语言变化的 loading 状态 |

移动端顶栏隐藏重复的 New project 按钮，因为项目创建入口仍在移动导航和页面主操作中
保留。Mock 标签在窄屏隐藏，演示模式提示仍出现在首页正文。

## 功能保全

| 能力 | 当前入口 | 保全结论 |
|---|---|---|
| GitHub 登录、仓库选择与项目创建 | `/login`, `/projects/new` | 原字段、安装选择、分支填充、校验和输入保留 |
| 构建、路径模式和项目归档 | `/projects/:id/settings` | 原设置、Root 安全说明和归档操作保留 |
| 部署筛选、搜索与状态过滤 | `/deployments` | URL 参数和原始状态保留，范围说明更明确 |
| 计划、费用上限与阻断原因 | 部署 Overview | 完整计划与操作条件仍可展开查看 |
| 钱包审批、切链和 EIP-712 签名 | 部署详情 | 仅在审批相关状态渲染，服务器检查仍权威 |
| 手动签名兜底 | 部署详情 | Payload、复制和签名提交路径保留 |
| 执行 | 部署详情 | 仅在 `APPROVED` 状态显示，服务端门禁不变 |
| 回滚 | 部署详情 | 仅在 `LIVE` 状态显示，仍创建需独立审批的新部署 |
| 文件、交易、验证、事件 | 部署 URL 分区 | 所有证据表、空态和直接链接保留 |
| 证据导出 | 部署头部 | 原 JSON 下载路由不变 |
| 容器、所有权、角色、TTL、域名绑定 | `/containers/:address` | 读写和钱包操作原样保留 |
| 组织、成员、预算 | `/organizations` | 原角色门禁和操作保留 |
| 设置、策略、成员、通知渠道 | 项目 Settings | 原表单与反馈保留 |
| Compare、Audit、Webhooks | 原路由 | 查询参数、载荷和空态保留 |
| 语言、通知、用户菜单、退出 | 全局壳层 | Cookie、已读状态和登录路由保留 |

完整逐项映射见
[`docs/ui-ux/FEATURE_PARITY.md`](../ui-ux/FEATURE_PARITY.md)。

## 主要改动

- 应用壳层与响应式样式：`apps/web/app/globals.css`
- 项目优先首页：`apps/web/app/page.tsx`
- 新项目列表：`apps/web/app/projects/page.tsx`
- 项目摘要：`apps/web/components/project-list.tsx`
- 部署详情分区：`apps/web/app/deployments/[id]/page.tsx`
- 快照与动作上下文：`apps/web/lib/console-views.ts`
- 状态相关操作说明：`apps/web/components/action-eligibility.tsx`
- 状态条件钱包操作：`apps/web/components/wallet-actions.tsx`
- 中英文字典：`apps/web/lib/i18n.ts`
- 本地化加载态：`apps/web/app/loading.tsx`
- 单元回归：`tests/unit/web-console-views.test.ts`
- 浏览器回归：`apps/web/e2e/console.spec.ts`
- 独立验收矩阵：`apps/web/e2e/supervisor.spec.ts`
- 实施说明：`docs/ui-ux/IMPLEMENTATION.md`
- 功能保全清单：`docs/ui-ux/FEATURE_PARITY.md`

## 测试与验收

本轮已执行的控制器验证：

```bash
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json --incremental false
node node_modules/eslint/bin/eslint.js apps/web/app apps/web/components apps/web/lib apps/web/e2e tests/unit/web-console-views.test.ts
node node_modules/vitest/vitest.mjs run tests/unit tests/ops
node node_modules/vitest/vitest.mjs run tests/unit/web-console-views.test.ts tests/unit/i18n.test.ts
git diff --check
NEXT_PUBLIC_TAPECI_MOCK=1 TAPECI_MOCK=1 NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build
```

结果：

- Web TypeScript：通过。
- 聚焦 ESLint：通过。
- Unit/Ops：20 个文件、358 个测试通过。
- 最终移动修正后的聚焦 Unit/I18n：13/13 通过。
- `git diff --check`：通过。
- 隔离生产构建：通过，所有原路由和 `/projects` 均出现在路由表。
- 完整浏览器验收：84/84 通过，耗时约 1.6 分钟；包含原有功能测试与独立监督矩阵。
- 最终移动端回归：390×844 语言入口、表格宽度和页面溢出断言通过。

独立监督覆盖完整页面矩阵、五个部署 fixture × 五个视图的 axe、EN/ZH、浏览器
错误收集、键盘检查、四视口截图和 overflow 检查。最终全新服务重跑结果与截图结论以
[`docs/ui-ux/VERIFICATION.md`](../ui-ux/VERIFICATION.md) 为准。

截图位于 `docs/ui-ux/screenshots/`，覆盖 1440×900、1280×800、768×1024 和
390×844。关键截图包括：

- `1440x900-home.png`
- `1440x900-projects.png`
- `1440x900-deployment-live-overview.png`
- `1440x900-deployment-build-failed-overview.png`
- `390x844-home.png`
- `390x844-projects.png`
- `390x844-deployment-live-overview.png`
- `390x844-deployment-build-failed-overview.png`

## 环境说明与限制

首次隔离构建的服务端返回 500，根因是从仓库根目录启动时 `distDir` 被解析到错误位置，
找不到 `prerender-manifest.json`。从 `apps/web` 目录使用同一 `distDir` 构建和启动后，
首页与项目页返回 200，完整浏览器套件恢复通过。该问题属于 QA 启动环境，不是产品
路由或 UI 回归。

隔离构建曾通过 symlink 将外部 `dist` 映射到 `apps/web/dist`，Next 生成的类型校验器
随后可能污染普通 TypeScript 检查。`apps/web/tsconfig.json` 现已排除 `dist/qa-*`，
避免 QA 临时产物影响源码检查；正常构建仍使用 `apps/web/dist`。

本次使用确定性 Mock 与本地生产构建，以下内容尚未由真实环境证明：

- 真实注入钱包、WalletConnect 和硬件设备的完整交互。
- 主网交易、真实预算扣费与回滚后的链上结果。
- 网关、DNS、域名过期和站点可访问性。
- 持久化 PostgreSQL API、真实 GitHub App 回调和多用户权限持久化。
- 真实日志、通知投递和长期并发行为。

真实钱包浏览器路径未验收；手动 EIP-712 路径仅保留源码和现有单元测试证据。
这些限制不会把 Mock 结果升级为链上或生产环境证据。

## 当前状态

改动保持在本地 `codex/gitlab-ui-ux` 分支，尚未提交、推送或部署。最终评审应结合完整
diff、`VERIFICATION.md` 和四视口截图检查功能保全；确认后再决定提交与发布步骤。
