# 决策：以 Session、Reprise harness 和 workflow 收敛重构目标

状态：accepted

## 问题

重构需要集中会话、工具权限、业务检查和生命周期的所有权。六层架构把业务产物、状态机、输入准备和审计均提升为公共基础模块，仍可能让一个业务决定散落于多个所有者。用户要求共用成熟 Agent 执行机制、完整本机历史和三平台本机运行。

## 决定

已确认的目标边界见[重构规划](../../plan/reprise-architecture-redesign.md)。本记录约束现行入口与所有权；未关闭的真实证据列在文末，不能写成已支持。

以 Pi 可用 Agent 能力为底座，Reprise 管理 Session 记录和执行约束；业务检查与 CandidateRun 状态由 harness 拥有，普通 workflow 组织用户入口。三个角色共用模型配置，各自连续使用独立 Session；Controller 模拟原用户，不强制独立 Understanding、Host 账本完成守卫或 Planner/Reporter 双会话。

用户运行中只查看和取消；恢复证据不足停止解释；对照从已保存运行结果独立发起。本机历史支持查看全过程，不要求恢复执行、跨机查看或跨系统重放。Windows 使用 PowerShell，macOS/Linux 使用 Bash。

CLI 与 TUI 共用应用操作并功能对等，完整 run 与 prepare → run --scenario → compare 分步执行共用实现。来源产品用 `--source-product`，候选产品用 `--product` 与 `--model`。活动身份由应用所有者在耗时探测前发布；CLI 不推导 operationId。活动所有者通过随进程生灭的本机控制端点接收其他终端的 cancel，保持每实验单写者；取消接收与终态清理完成分别表达。启动装配处把已解析 Pack lookup 注入 Workflow，查询已保存历史不加载 Pack。

Product Pack 通过显式配置的本地 JavaScript、TypeScript 编译产物或已安装包启动加载，首版作为可信本地代码。采用版本化窄契约、独立能力声明与公共活动数据。旧实验查看不依赖原插件。对照消费封存快照。

TUI 采用键盘优先的斜杠入口、分层列表选择和本地产物链接。阅读与折叠见[公开活动时间线](./2026-09-08-public-activity-timeline.md)与[TUI 规划](../../plan/reprise-tui-design.md)。真实终端交互以[平台证据矩阵](../../plan/2026-09-08-platform-evidence-matrix.md)为准。

## 备选方案

**双窗口与原生 TUI 嵌入。** 同会话附着能力依赖产品，且容易引入人工输入及终端控制冲突。

**六层与五件套内核。** 业务权限、完成规则和输入形式跟随工具、角色和记录所有者即可。

**完整自研通用 Agent 框架。** 重复 Pi 已有模型适配与循环，没有独立产品需求支撑。

**直接采用全部 Pi AgentHarness API。** 所检查的接口存在占位实现，不能把接口声明视为可用保证。

**跨机可移植与断点续跑。** 用户仅需本机历史查看。

**统一 Bash。** 不以安装 Git Bash 或 WSL 作为前置要求。

**CLI 模拟 TUI 或另写编排。** CLI/TUI 各自调用公共应用操作。

**静态源码注册或插件市场。** 超出当前范围，采用显式本地配置。

**后台服务统一调度或按 PID 直接取消。** 活动所有者接收本机请求并执行统一收尾。

## 影响

现行规范以 architecture/、product/ 与本记录为准。未验证组合不得写入支持声明。真实模型、Runtime smoke 与非 Windows 真终端仍须显式 opt-in，默认检查不产生外部费用。Agent 生产 `streamFn` 对拍默认只覆盖写失败阻断与 digest 钩子，真实 provider 须 `REPRISE_AGENT_CONTEXT_PROBE=1`。Controller 付费 lane 须 `REPRISE_REAL_MODEL=1`。macOS/Linux 真终端矩阵已写、本轮 unverified。

## 验证

`test/cli-protocol.test.ts`、`test/architecture.test.ts`、`test/product-registry.test.ts`、`test/tui-workflow.test.ts` 覆盖来源/候选拆分、真实 activity 先于探测、JSON schema、lookup 隔离。`npm run check` 通过。反向：prepare 仍用 `--product` 当来源且要求 `--model`，或 Workflow 回退 `findProductPack`，则红。
