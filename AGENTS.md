# Superpowers

[Superpowers](https://github.com/obra/superpowers) is installed globally for DeepSeek Harness at `~/.agents/skills/` (15 skills). Every project on this machine can use them; this project also keeps the upstream checkout at `superpowers/`.

## Bootstrap

At the start of every conversation, invoke the `using-superpowers` skill **before responding**, including before clarifying questions. This is the DeepSeek Harness equivalent of Superpowers' `SessionStart` hook.

## Available skills

brainstorming, diagnosing-superpowers, dispatching-parallel-agents, executing-plans,
finishing-a-development-branch, receiving-code-review, requesting-code-review,
subagent-driven-development, systematic-debugging, test-driven-development,
using-git-worktrees, using-superpowers, verification-before-completion,
writing-plans, writing-skills.

## Notes

- Installed copy: `~/.agents/skills/` (what the model and the Skill Center see).
- Source checkout: `superpowers/` — update with `git -C superpowers pull`, then re-copy: `cp -R superpowers/skills/. ~/.agents/skills/`.
- This file is optional: delete it if you do not want Superpowers to auto-activate in this project.

---

# TapeCI — Codex 开发执行规则

## 项目目标

构建一个 X Layer 196 上的 GitHub-to-DeWEB 自动化发布工具：固定 Git Commit 构建静态资源、生成可复现 Manifest、链上分块发布、双独立 RPC 回读验证、版本回滚。

## 必读文件

1. `TapeCI_PRD_Technical_Design.md`（唯一产品与技术范围基准）
2. `schema.sql`（拟定数据库迁移基线；上线前必须校验）
3. TapeKit 官方代码：https://github.com/TapeOutProtocol/TapeKit

## 强制工作顺序

- 首轮**仅执行 P0-01 至 P0-06**，不要开发全套 UI、不要部署真钱主网交易。
- P0 必须核验当前 X Layer 的 Factory / Opener / SiteRegistry / DomainBinding 地址、合约代码、EIP-1967 实现槽、write ABI 和存储写入权限。
- 使用 Anvil fork + 测试账户；真实主网测试（P0-07）必须由用户明确授权并指定费用限制。
- P0 结束提交 `docs/P0_DECISION.md`，明确 GO / NO-GO 与证据；仅在 GO 后开始 P1。

## 每个任务必须附带

- 修改文件列表
- 实现摘要与依赖版本
- 执行过的具体测试命令、通过/失败结果
- 未验证事实与已知风险
- fork 区块号、配置快照、交易哈希或测试证据（适用时）

## 红线

- 不保存用户主钱包私钥，不提交任何 Secret。
- 不把普通 GitHub Actions 构建误称为“密码学可证明构建”。
- 不因为交易 receipt success 就直接标记站点 LIVE。
- 不在 RPC 分歧、合约 implementation 变化、权限撤销、费用超预算时继续链上写入。
- 不跨网络误用 BNB Chain 的地址/费用/API 假设。
- 不生成“成功发布”的伪造链上证据。
- 同一 Container 最多一个进行中的链上写入任务，重复 Webhook 必须幂等。

## 首轮完成的验收

- `pnpm test`、`pnpm lint` 和 fork smoke test 实际执行日志。
- X Layer 196 上候选合约接口核对报告。
- 1/24000/24001/65000 字节文件上传的 fork 测试记录。
- 尝试重复 appendChunk 时的明确拒绝或防重复证明。
- TapeKit 不同 RPC 运营方同一 pinned block 的验证报告。
- 尚未满足的任何条件都列为 NO-GO 阻断项。

## 技术建议

TypeScript strict、Viem、Vitest、pnpm Workspace、PostgreSQL 16+、BullMQ、GitHub App / Actions；构建 Runner 与链上 Operator 秘钥隔离。对路径使用 NFC 与严格 canonicalization，文件校验采用 SHA-256，链上签名所需 EIP-712 digest 单独计算。
