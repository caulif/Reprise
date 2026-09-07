# Reprise 重构进度

## 当前目标

- 实施 [Session / harness / workflow 架构重构](../plan/reprise-architecture-redesign.md)。
- 当前代码仍遵循 `architecture/` 与 `decisions/accepted/`；目标规划不表示已经迁移。

## 当前批次

- M1：执行机制与持久化，先验证 Pi Session/JSONL、压缩和持久化的可用范围。

## 已确认范围

- 三角色共用内部模型配置，各自使用连续独立 Session。
- 运行中只查看和取消；重开后只查看历史，不自动续跑。
- Windows 默认 PowerShell，macOS/Linux 默认 Bash；各平台运行本机任务。

## 验证记录

- M0：`npm run verify:docs` 通过；旧计划、研究和进度材料已迁入本机归档，受控入口、链接和目录边界已收口。
