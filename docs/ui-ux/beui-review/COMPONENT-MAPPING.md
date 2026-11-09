# TapeCI × Be UI component replacement review

Date: 2026-10-29. Status: **A01–A07 approved and implemented on 2026-10-30; all other items remain pending**.

This is a researched proposal, not an implementation record. The original review did not change application source. The subsequently approved A01–A07 implementation is documented in [A01-A07-IMPLEMENTATION.md](A01-A07-IMPLEMENTATION.md). No subagents were used.

A = recommended adaptation; B = selective or presentation-only adaptation; C = optional scope expansion requiring separate approval. Costs are relative implementation/retest estimates, not measured hours. Every row remains pending until selected by the user.

## Candidate mapping

| ID | Current page / area | Be UI candidate | Proposed adaptation and retained behavior | Cost | Decision |
| --- | --- | --- | --- | --- | --- |
| A01 | 部署详情 / 发布生命周期 | [Animated Badge + Animated Collapsible](https://beui.dev/components/motion/animated-badge) | 重绘为四节点细线进度；当前阶段一句说明，其余解释折叠。不是现成流程 Stepper，需组合开发。 | 中 | Approved; implemented |
| A02 | 部署详情 / 审批与执行 | [Approval Card](https://beui.dev/components/agents/approval-card) | 借用审核摘要与底部操作区；保留 manifest、费用上限、钱包签名与阻断规则，不采用问答示例。 | 中 | Approved; implemented |
| A03 | 部署详情五个标签、项目页面导航 | [Tabs](https://beui.dev/components/motion/tabs) | 采用 underline 样式及平滑指示条；保留 ?view=、刷新、前进后退和链接语义。设置页仍为锚点，不隐藏未保存表单。 | 中 | Approved; implemented |
| A04 | 部署列表、项目、资源 / 状态标签 | [Animated Badge](https://beui.dev/components/motion/animated-badge) | 统一图标与颜色；仅真实状态改变时过渡，失败与 Live 继续由原状态机判定。 | 低 | Approved; implemented |
| A05 | 全站 / 保存、审批、重试、复制 | [Button / Action Swap](https://beui.dev/components/motion/button) | 只用普通和 Stateful 变体，清楚区分等待钱包、提交中、成功和失败；不用磁吸位移。 | 中 | Approved; implemented |
| A06 | 部署 / 域名说明、阻断原因、技术细节 | [Animated Collapsible](https://beui.dev/components/motion/collapsible) | 统一展开箭头、间距与动画；当前阻断原因、付款前费用等必要信息不默认藏起。 | 低 | Approved; implemented |
| A07 | 全站 / 错误、费用和风险提示 | [Animated Alert](https://beui.dev/components/motion/alert) | 减少厚重边框，统一标题与正文；保留 alert/note 语义，不自动消失重要风险。 | 低 | Approved; implemented |
| A08 | 新建项目、设置、地址查询、域名 | [Input](https://beui.dev/components/motion/input) | 统一标签、帮助文字、错误行和焦点；保留原生 name、表单提交、验证与粘贴行为。 | 中 | Pending |
| A09 | 新建项目 / 仓库；项目选择；处理器筛选 | [Combobox](https://beui.dev/components/motion/combobox) | 给已有选择与筛选增加搜索，适合长列表；处理器列表仍显示价格，不能只变成地址下拉。 | 中 | Pending |
| A10 | 部署筛选、组织/成员角色、压缩网关 | [Select](https://beui.dev/components/motion/select) | 统一下拉面板，减少夸张变形；必须桥接 name/hidden input、受控值和 Server Actions。 | 中 | Pending |
| A11 | 压缩方案、路径模式等互斥选择 | [Radio Group](https://beui.dev/components/motion/radio) | 少量固定选项可用单选卡；未知或不可用方案仍禁用，不能自动切换审批后的方案。 | 中 | Pending |
| A12 | 严格模式、SPA fallback、归档确认 | [Checkbox](https://beui.dev/components/motion/checkbox) | 统一勾选与焦点；危险操作保持明确确认，不能改为一拨即归档。 | 低 | Pending |
| A13 | 全站 / 哈希、地址、图标按钮辅助说明 | [Tooltip](https://beui.dev/components/motion/tooltip) | 支持键盘与触摸，不仅 hover；完整哈希仍可复制，关键费用和风险不放入提示框。 | 低 | Pending |
| A14 | 移除成员、回滚等二次确认 | [Morphing Modal](https://beui.dev/components/motion/morphing-modal) | 主要借鉴排版与轻微过渡，保留既有 Radix 焦点管理、取消和确认，不重新实现权限逻辑。 | 中 | Pending |
| A15 | 保存、复制、刷新等操作结果 | [Animated Toast Stack](https://beui.dev/components/motion/animated-toast-stack) | 提供轻量结果反馈；表单错误仍留在字段旁，Toast 不取代持续可见的错误或交易凭据。 | 中 | Pending |
| A16 | 顶栏 / 页面层级 | [Animated Breadcrumb](https://beui.dev/components/motion/breadcrumb) | 更清晰展示项目→设置或部署→详情；保留实际路由与返回路径。 | 低 | Pending |
| A17 | 项目行、钱包摘要、费用摘要、登录卡 | [Card](https://beui.dev/components/motion/card) | 统一 header/content/footer 和 compact 间距；不恢复层层卡片嵌套，也不让整卡与内部按钮冲突。 | 低 | Pending |
| B01 | 全站 / 侧栏 | [Animated Sidebar](https://beui.dev/components/motion/animated-sidebar) | 可增加桌面图标折叠栏；保留全部导航、活动路由与固定项目。不是只换背景，需完整导航回归。 | 高 | Pending |
| B02 | 手机 / 导航抽屉 | [Drawer](https://beui.dev/components/motion/drawer) | 可借鉴侧滑与遮罩；保留既有焦点、Escape、点击导航关闭、滚动锁定。与 B01 合并设计以免两套抽屉。 | 中 | Pending |
| B03 | 顶栏 / 通知列表 | [Notification Stack](https://beui.dev/components/blocks/notification-stack) | 借鉴紧凑摘要和展开列表；未读、全部已读、打开部署仍使用现有 API。支持点击而非仅悬停。 | 中 | Pending |
| B04 | 首页、资源 / 钱包摘要 | [Wallet Card](https://beui.dev/components/blocks/wallet-card) | 只用地址、网络、复制和连接状态部分；没有真实余额数据时不显示余额，不引入转账/兑换按钮。 | 中 | Pending |
| B05 | 部署 / 文件产物 | [File Tree](https://beui.dev/components/motion/file-tree) | 目录浏览作为文件表的补充；保留文件大小、hash、RPC 验证和交易状态，树不能代替所有列。 | 中 | Pending |
| B06 | 手动签名 / EIP-712 数据；技术响应展示 | [Code Block](https://beui.dev/components/agents/code-block) | 只替换只读 pre，保留精确数据和复制；签名输入 textarea 不能变成只读代码块。不凭空新增构建日志。 | 中 | Pending |
| B07 | 部署、审计、Webhook、成员、验证 / 表格 | [Table](https://beui.dev/components/motion/table) | 先借鉴表头和行密度；虚拟滚动仅大数据量时考虑。保留服务器排序/分页、URL 参数、手机卡片和全部证据列。 | 高 | Pending |
| B08 | 资源 / 开启容器与准备进度 | [Todo List](https://beui.dev/components/agents/todo-list) | 只借任务分组、状态图标和展开细节；不可手动勾选完成，进度必须来自任务/API 状态。 | 中 | Pending |
| B09 | 项目 / 发布历史；部署事件 | [Timeline](https://beui.dev/components/motion/timeline) | 仅作为发布历史概览候选；其横向日期卡不适合直接替换密集审计日志。事件原始列表需保留。 | 中 | Pending |
| B10 | 项目详情 / 设置、比较、审计等次要操作 | [Overflow Actions](https://beui.dev/components/blocks/overflow-actions) | 次要操作收进“更多”；主操作及高风险动作名称始终明确，不能只靠悬停展开。 | 中 | Pending |
| B11 | 容器 / 域名绑定月份 | [Adaptive Stepper](https://beui.dev/components/motion/adaptive-stepper) | 对应真实的数字加减输入；保留最小值/最大值与修改月份后重新报价。不能用它做发布步骤条。 | 中 | Pending |
| B12 | 首页 / 项目数、部署数等计数 | [Number Animation](https://beui.dev/components/motion/number) | 只用于非关键统计的短暂更新；交易费用、批准上限和钱包地址保持稳定精确。 | 低 | Pending |
| B13 | 全站 / 请求等待 | [Loader](https://beui.dev/components/motion/loader) | 选安静的 spinner/dots，用于按钮或局部查询；首次页面加载保留骨架，不使用装饰性复杂动画。 | 低 | Pending |
| B14 | 404 / 不存在的项目或路由 | [404 / Not Found](https://beui.dev/components/blocks/not-found) | 可选简洁终端风；保留返回入口，不采用持续 glitch 或追随鼠标效果。 | 低 | Pending |
| C01 | 顶栏 / Cmd+K | [Command Palette](https://beui.dev/components/blocks/command-palette) | 新增全局命令交互：先页面导航和已加载项目；全仓库/提交搜索需另核验 API 与权限范围。当前只存在搜索快捷聚焦。 | 中至高 | Pending |
| C02 | 审计、部署 / 时间范围筛选 | [Date Range Picker](https://beui.dev/components/motion/date-range-picker) | 属于新增功能：目前筛选/API 不等于已有日期筛选。需后端支持、时区定义及分页一致性。 | 高 | Pending |
| C03 | 项目 / 版本差异 | [File Diff](https://beui.dev/components/agents/file-diff) | 当前比较是路径与 hash；文本逐行 diff 需要可读取的两版内容。先保留 hash 比较，不能伪造源码差异。 | 高 | Pending |
| C04 | 手机 / 筛选或费用摘要 | [Bottom Sheet](https://beui.dev/components/motion/bottom-sheet) | 当前主要是内联表单，改成抽屉是交互重构。仅考虑筛选/只读摘要，不用拖动关闭导致签名状态丢失。 | 中 | Pending |
| C05 | 全站 / 明暗主题 | [Theme Toggle](https://beui.dev/components/motion/theme-toggle) | 当前以既定深色方案为主；切换主题需补齐浅色 token、偏好保存和全页面对比度，不能只加开关。 | 高 | Pending |

## Source file map

- A01: [components/release-milestones.tsx](/Users/a77/Desktop/tapeout/apps/web/components/release-milestones.tsx)
- A02: [components/deployment-actions.tsx](/Users/a77/Desktop/tapeout/apps/web/components/deployment-actions.tsx)
- A03: [app/deployments/[id]/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/deployments/[id]/page.tsx)
- A04: [components/stage-badge.tsx](/Users/a77/Desktop/tapeout/apps/web/components/stage-badge.tsx)
- A05: [components/copy-value.tsx](/Users/a77/Desktop/tapeout/apps/web/components/copy-value.tsx)
- A06: [components/action-eligibility.tsx](/Users/a77/Desktop/tapeout/apps/web/components/action-eligibility.tsx)
- A07: [components/risk-notice.tsx](/Users/a77/Desktop/tapeout/apps/web/components/risk-notice.tsx)
- A08: [components/new-project-form.tsx](/Users/a77/Desktop/tapeout/apps/web/components/new-project-form.tsx)
- A09: [components/mint-flow.tsx](/Users/a77/Desktop/tapeout/apps/web/components/mint-flow.tsx)
- A10: [components/compression-preparation-panel.tsx](/Users/a77/Desktop/tapeout/apps/web/components/compression-preparation-panel.tsx)
- A11: [components/compression-preparation-panel.tsx](/Users/a77/Desktop/tapeout/apps/web/components/compression-preparation-panel.tsx)
- A12: [app/projects/[id]/settings/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/projects/[id]/settings/page.tsx)
- A13: [components/copy-value.tsx](/Users/a77/Desktop/tapeout/apps/web/components/copy-value.tsx)
- A14: [components/confirm-button.tsx](/Users/a77/Desktop/tapeout/apps/web/components/confirm-button.tsx)
- A15: [components/copy-value.tsx](/Users/a77/Desktop/tapeout/apps/web/components/copy-value.tsx)
- A16: [components/console-breadcrumb.tsx](/Users/a77/Desktop/tapeout/apps/web/components/console-breadcrumb.tsx)
- A17: [components/project-list.tsx](/Users/a77/Desktop/tapeout/apps/web/components/project-list.tsx)
- B01: [app/layout.tsx](/Users/a77/Desktop/tapeout/apps/web/app/layout.tsx)
- B02: [components/shell-nav.tsx](/Users/a77/Desktop/tapeout/apps/web/components/shell-nav.tsx)
- B03: [components/notification-bell.tsx](/Users/a77/Desktop/tapeout/apps/web/components/notification-bell.tsx)
- B04: [components/workbench-wallet.tsx](/Users/a77/Desktop/tapeout/apps/web/components/workbench-wallet.tsx)
- B05: [app/deployments/[id]/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/deployments/[id]/page.tsx)
- B06: [components/manual-signature.tsx](/Users/a77/Desktop/tapeout/apps/web/components/manual-signature.tsx)
- B07: [components/deployment-table.tsx](/Users/a77/Desktop/tapeout/apps/web/components/deployment-table.tsx)
- B08: [components/prepare-open-panel.tsx](/Users/a77/Desktop/tapeout/apps/web/components/prepare-open-panel.tsx)
- B09: [components/event-timeline.tsx](/Users/a77/Desktop/tapeout/apps/web/components/event-timeline.tsx)
- B10: [app/projects/[id]/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/projects/[id]/page.tsx)
- B11: [components/bind-name-form.tsx](/Users/a77/Desktop/tapeout/apps/web/components/bind-name-form.tsx)
- B12: [app/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/page.tsx)
- B13: [components/skeleton.tsx](/Users/a77/Desktop/tapeout/apps/web/components/skeleton.tsx)
- B14: [app/not-found.tsx](/Users/a77/Desktop/tapeout/apps/web/app/not-found.tsx)
- C01: [components/search-shortcut.tsx](/Users/a77/Desktop/tapeout/apps/web/components/search-shortcut.tsx)
- C02: [app/audit/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/audit/page.tsx)
- C03: [app/projects/[id]/compare/page.tsx](/Users/a77/Desktop/tapeout/apps/web/app/projects/[id]/compare/page.tsx)
- C04: [components/prepare-open-panel.tsx](/Users/a77/Desktop/tapeout/apps/web/components/prepare-open-panel.tsx)
- C05: [app/layout.tsx](/Users/a77/Desktop/tapeout/apps/web/app/layout.tsx)

## Lifecycle decision

The screenshot contains three problems: duplicate container/card borders, connectors crossing text, and four long descriptions occupying the primary scan line. The component also calls `stageInfo(stage)` without the active locale, which explains the English step copy on a Chinese page.

The existing four canonical stages remain Build Success → Uploaded → Verified → Live. A01 is a custom process strip composed from existing state/evidence logic plus Be UI badge/disclosure styling. The proposal does not suggest fake percentages, manually completing stages, or treating approval as a fifth canonical publication milestone. Approval remains a separate action state.

Be UI's Adaptive Stepper is a numeric control, not a lifecycle stepper. Its appropriate existing mapping is B11 (domain months). Its Timeline is a date-centered draggable history view, not a direct substitute for cumulative release evidence.

## Dependency and behavior notes

The current web package declares React, Next.js, Lucide and Radix; it does not currently declare Motion or Tailwind CSS. Be UI documents a copy-source model using Motion and Tailwind. The public registry was checked for tabs, table, animated-sidebar, approval-card, wallet-card, collapsible, button and combobox. These list `motion`, `clsx`, `tailwind-merge` and related React/Lucide dependencies; Table additionally lists `@tanstack/react-virtual`.

This is not a drop-in package swap. Recommended approach: agree the selected components first, add only the required animation infrastructure, translate styles to TapeCI tokens, and preserve the existing business handlers. Avoid making every server-rendered page a large client component. Evaluate payload and keyboard/reduced-motion behavior during a prototype, without claiming a measured bundle impact yet.

Special retention checks: native form names/Server Action payloads; URL paging/filter/sort and deployment `?view=`; focus return/Escape; unsaved settings; raw decimal fees and hashes; no unsigned operations becoming enabled; no wallet account or ownership assumptions; real persisted evidence before completed status.

Public component examples are the research scope. No paid Pro purchase or account registration is included. Any imported source should have its license/attribution checked at implementation time.

## Not recommended for the current console

- Bounce Sidebar, Tilt Card, Magnetic/Metallic Button, Shader Background, Marquee, Cylinder Carousel: continuous/decorative movement does not improve deployment operations.
- Dock, Preview Rail, Bloom Menu: would duplicate the existing app navigation and obscure action names.
- Swipeable List for destructive/paid actions: keep explicit readable controls.
- Arc Picker, Wheel Picker and Range Slider for fees or signing values: precision matters; do not replace exact numeric fields with gesture controls.
- Multi-chain Swap, Prediction Market, Voice Orb and full Chat App: different product scope.
- Color Picker/Selector, Image Viewer/Generation, Aspect Ratio, File Upload, Infinite Masonry, Card Dealer, Card Folder, Fixtures and Availability Scheduler: no matching current workflow requiring replacement.
- OTP Input and Sign Up Form: existing sign-in uses GitHub OAuth, not passwords or OTP.
- File Diff, date filters, theme switching, drag-reordering pinned projects, feedback submission and chart dashboards require actual supporting data/behavior; do not add purely to use a visual component.
- A source-based Table's 10k-row claim is its vendor description, not a TapeCI benchmark.

## Suggested confirmation order

1. First visual batch: A01, A02, A03, A04, A06, A07 (the release-review experience).
2. Global control consistency: A05, A08–A17 as selected.
3. Select B items individually after the first batch is reviewed.
4. Defer C unless the user explicitly wants new functionality.

Reply using IDs, for example: `Approve A01–A07, B04 and B05; defer the rest`. Approval selects the implementation scope; it does not authorize mainnet transactions, deployment or paid purchases.

## Sources

- [Be UI public component directory](https://beui.dev/components/motion)
- [Be UI machine-readable index](https://beui.dev/llms.txt)
- [Be UI registry](https://beui.dev/r)
- Each row links the specific official component page used for assessment. Some Markdown detail endpoints were unavailable; HTML docs and public registry metadata were used instead.
