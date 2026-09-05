# 决策：Comparison 使用双 session attempt，并复用 Pi 原生内容与生命周期

状态：accepted
日期：2026-09-05

## 问题

单次 Comparison completion 同时决定比较对象、调查证据和编写 HTML，容易在上下文中过早固化结论；旧的报告沙箱也不能清楚表达重试隔离。共享 Agent Host 过去只传文本，图片工具结果会在 provider 边界丢失，压缩也无法按角色和阶段保留真正重要的状态。

## 决定

每次比较创建新的 `comparison-attempts/{attemptId}`。Planner 与 Reporter 使用两个独立 Pi session，但都记录为 `comparison` role。Planner 把可修改的调查计划写到 `work/comparison-plan.md`；Reporter 重新读取 briefing 和计划，可以否定、清空或改写它，并独立生成 `report.html`。Planner 失败不阻止 Reporter；计划状态为 `ready`、`partial_unverified` 或 `unavailable`。

Host 为每个阶段持久化实际输入快照、digest、attempt、phase 和独立 operationId。Reporter 快照包含启动时看到的计划正文。成功 HTML 从本 attempt 原子发布到实验根；失败不覆盖旧成功报告。计划与 scratch 都不是领域 artifact，也不会成为下一 attempt 的权威输入。

实验根的 `comparison.json` 明确是 latest attempt envelope，可被后续 attempt 原子替换；历史状态由事件日志和各自的 attempt 目录保留。briefing context、链接目录和 phase input 均在写入前经过 TypeBox `Value.Check`。

briefing 只放 orientation、导航索引、Host facts、结果链接和完整 candidate process index。历史 transcript、candidate turn、保留的隔离副本与 Host artifacts 通过只读 mount 按需读取。PowerShell 从 attempt 的 `scratch/` 启动，并获得四个 task-scoped root 环境变量；不增加专用转换工具，也不限制可用本地程序。

共享 Pi 适配层保留原生 text/image content blocks，调用 `Agent.prompt(message, images?)`，工具结果不自行改写成 provider 私有格式。模型输入能力直接取自 Pi `model.input`，既写入 session 审计，也以短能力说明注入当前 user message。Pi `beforeToolCall` 是 session 生命周期闸门，`afterToolCall` 通过 Host callback 统一报告工具结果 metadata；路径、写入、隐私与敏感文件策略仍只由工具工厂决定。压缩继续使用 Pi compaction，但传入角色/阶段专用 `customInstructions`。

HTML 只校验文件存在、路径和可读性，不校验 DOM、章节、首屏结构或 CSP。报告不必宣布 winner；首屏突出关键差异和双方原始结果入口是 prompt 目标。

## 未采用

- 单 session 先规划再写报告：规划历史会挤占 Reporter 上下文，也无法验证 session 隔离。
- 把计划注册成不可变 artifact：会错误地抬高临时推理状态的权威性。
- Reprise 自建媒体/provider 编码或能力枚举：重复 Pi 已有边界并增加适配分叉。
- viewer、CSP 或 DOM 模板门禁：本地自生成证据不需要这一层产品约束。
- 第一版加载 skills：尚无稳定、重复的 artifact 处理缺口，先用 prompt 与通用工具。

## 影响

事件协议、提示词契约和 attempt 磁盘布局发生兼容性新增；旧 `comparison.requested` 与 `compare()` port 暂时保留。审计不保存 base64 内容、凭据或完整敏感 payload。跨平台 shell backend 延后到第二个平台实际接入时抽取，当前仍以 Windows 11/PowerShell 为已验证实现。

## 验证

测试覆盖双 session、plan 状态与输入恢复、attempt 隔离、原子发布、原生图片 block、能力审计、两条 compaction 路径、读图授权和 process index。项目门禁仍以 `npm run check` 为最终完成信号。
