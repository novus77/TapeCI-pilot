# TapeCI 开发交付包

版本：v1.0 · 2026-10-19

本包属于**实施规范和项目脚手架设计**，不是已经完成部署的 TapeCI 应用。

## 文件

- `TapeCI_PRD_Technical_Design.md`：Codex 首选；完整产品 PRD、架构、状态机、API、分阶段任务、测试矩阵、来源。
- `TapeCI_PRD_Technical_Design.docx`：Word 审阅版，与 Markdown 同步，18 页。
- `schema.sql`：PostgreSQL 16+ 初始 DDL 草案。**尚未在实际数据库执行迁移测试**。
- `AGENTS.md`：Codex 项目级工作规则；优先执行 P0-01～P0-06。

## 推荐使用流程

1. 把这个压缩包解压到新建的空 GitHub 仓库根目录。
2. 将 `AGENTS.md` 与 `TapeCI_PRD_Technical_Design.md` 提供给 Codex。
3. 第一次让 Codex **只执行 P0-01～P0-06**（只读链、Anvil fork 测试），并输出 `docs/P0_DECISION.md`。
4. P0 通过后再执行 P1 CLI 与链上发布器；之后 P2 GitHub Actions / Web。
5. 涉及主网实际花费的 P0-07 必须得到用户明确批准，并指定预算。

## 重要声明

- 公开的 TapeKit `SPEC.md` v0.2 主要以 BNB Chain 为基准，X Layer 的当前代理合约实现和 ABI 需要单独验证。
- 目前未进行 TapeCI 的实际链上部署，也没有执行真实资金交易。
- Word 文档已完成本地渲染审阅；SQL 文件是设计级草案，不能当成已经完成的生产数据库迁移。
