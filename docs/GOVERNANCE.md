# 治理

项目由 `@caulif` 维护并对合入与发布决定负责。没有委员会、投票制或固定发布周期；贡献数量、等待时间或 Agent 身份都不自动授予合并、发布或接管权限。

## 决策

单人日常采用[贡献指南](./CONTRIBUTING.md)的轻流程；外部 PR 在此基础上补足可审查材料。长期选择及真实弃案写入 [ADR](./decisions/README.md)，不在 Issue、PR 或 Agent 指令中建立另一套长期规范。

当前跨模块语义由[架构总览](./architecture/overview.md)拥有，产品行为由[产品定义](./product/overview.md)拥有；计划是目标，不代表当前规则已生效。ADR 状态与豁免按 [ADR 指南](./decisions/README.md)判断。

## 所有者与敏感路径

[CODEOWNERS](../.github/CODEOWNERS)指定 `@caulif` 为仓库所有者，并显式标出敏感路径。外部 PR 触及下列内容时，由维护者核对契约、失败场景、ADR 与验证证据：

- [架构规范](./architecture/)与[产品规范](./product/)：当前行为、所有者和迁移边界。
- [核心协议与 schema](../src/core/)、[产品 Pack](../src/products/)：Runtime 端口、公共协议和持久化格式。
- [Agent](../src/agents/)、[应用编排](../src/application/)、[环境](../src/environment/)与[基础设施](../src/infrastructure/)：提示词、工具面、事件复原、进程与凭据边界。
- [CLI](../src/cli/)与 [TUI](../src/tui/)：公开命令、只读投影、证据展示与敏感信息外泄风险。
- [门禁脚本](../scripts/)、[工程门禁](./engineering-gates.md)、[依赖与命令](../package.json)、[锁文件](../package-lock.json)及 [GitHub 配置](../.github/)：验证、供应链与发布流程。

CODEOWNERS 表达所有者和审查路由，不授予 GitHub/npm 权限，也不证明分支保护或强制审批已经配置。仓库权限由实际平台配置决定；本文不设虚构的第二审查者或额外批准权。

## 审查、发布与交接

维护者检查代码与可复现证据，不仅看 Agent 总结。发布按[发布检查单](./release-checklist.md)，安全事项按[安全政策](./SECURITY.md)处理。无法响应时，贡献者可在 Issue 中提出维护或交接建议，但不得据此自行宣称拥有仓库、发布凭据或安全公告权限。
