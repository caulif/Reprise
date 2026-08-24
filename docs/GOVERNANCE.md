# 治理

当前阶段由 `@caulif` 维护。没有委员会、投票权或固定发布火车。

## 决策

长期约束实现的选择写在 [`docs/decisions/`](./documentation-structure.md#决策记录)。架构跨模块语义以 [`architecture/overview.md`](./architecture/overview.md) 为准。日常工程指令在各层 `AGENTS.md`，它们不覆盖 `architecture/` 或 `product/`。

## 权限

发布 npm 包、保护 GitHub environment、以及安全公告的权限属于维护者。贡献者通过 PR 提交；合并前按 [CONTRIBUTING.md](./CONTRIBUTING.md) 验证。

## 接管

若维护者连续 90 天无法响应 Issue 中的安全或发布阻断项，有意接管的人应先开 Task Issue，说明将如何保管发布凭据与安全联系方式。在此之前不要假设自己拥有发布权。
