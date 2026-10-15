# 决策：共享 Agent 截止与同层依赖方向

状态：accepted

## 问题

24 小时默认值散落且 Recovery 外层不能配置；Node 超过 `2^31-1` 毫秒的单次计时会变成 1 毫秒。同层 rank 检查也未阻止 infrastructure 反向引用 products。

## 决定

默认时间统一引用 core 的 `DEFAULT_AGENT_DEADLINE_MS`，继续采用[24 小时默认值](2026-10-14-agent-default-budgets.md)。`RecoveryAttemptInput.timeoutMs` 可覆盖整体截止；工作流传入现有 `recoveryBudget.callTimeoutMs`，未配置保持默认。截止覆盖准备、模型、校验和封存，返回时清理计时器。Agent Session、Candidate turn 与 Recovery 使用共享分段计时器，每段不超过 Node 上限，长预算不会提前到期。

证据引用目录由 core 持有，products 与 infrastructure 共同使用。相同 rank 的跨模块引用仅允许 agents、environment、products 指向 infrastructure；模块内部引用仍允许。门禁自测必须拒绝 infrastructure 的反向引用及未授权的兄弟模块边，避免形成同层模块环。

开发依赖 knip 升级至 6.x、jscpd 至 5.x；保留重复率 1% 门槛与原扫描范围。knip 仅豁免 Windows 系统自带的 `where`、`icacls.exe` 二进制，不将其当作 npm 依赖。

## 备选方案

**只截断延时或限制 schema 上限**：会提前结束长预算或拒绝已有合法配置，不采用。

**只调整 infrastructure rank**：不能明确约束其他兄弟模块边；采用显式允许边。

## 影响

默认预算及持久化格式不变。Recovery 调用方可缩短或延长整体截止；新的同层依赖必须符合既定方向，不能靠 rank 相同绕过门禁。

## 验证

分段计时器用模拟时钟检查跨段、超大预算、到期和取消；模型与 Candidate 回归检查超大预算不会立即超时。分层自测包含反向拒绝用例；执行项目门禁和 npm audit，不调用真实模型。
