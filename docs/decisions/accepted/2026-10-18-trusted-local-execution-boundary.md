# 决策：可信本地启动环境与边界记录

状态：accepted

## 问题

Candidate 的环境覆盖曾被 Runner 再合并宿主环境；共用 spawn 还服务浏览器和 Host shell。仅过滤应用层调用参数会回灌秘密，全局替换 spawn 则会混淆进程角色。静态工作区隔离声明也无法证明本次原生配置。

## 决定

Candidate 使用角色允许列表，不能把 Harness 进程的所有环境交给 Runtime。通用 spawn 同时承载浏览器和 managed shell，因此不全局替换历史行为；新增 completeEnv 表示完整环境，不再补宿主变量。旧 env 仍表示受信任本地调用方覆盖项；Codex/Claude client 先选基础环境与产品配置，再应用覆盖项。未知宿主变量、运行时注入与无关认证默认不继承；显式覆盖禁止 Git 防线绕过和已知运行时注入。Host shell 的覆盖仅允许现有 Host 挂载位置。

基础环境保留 Windows 工具链、用户配置定位和 locale。Codex 额外选择 CODEX_HOME、OPENAI_BASE_URL，沿用原生文件登录，不读取或复制 Codex 凭据。Claude 选择 CLAUDE_CONFIG_DIR、CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL。两者选择标准代理、CA 变量，仅在内存消费值。受信任本地覆盖可明确选用其他变量，不能由模型或工具参数设置。目录查询和文本调用保留各自协议参数，也使用产品环境选择；Codex 的非 Candidate 服务入口保留原有 OPENAI_API_KEY 认证来源，不能将此规则用于 Candidate。浏览器保留原入口语义。

可选 ProductRuntime.prepareExecution 返回脱敏记录与捕获同一配置的 Runner 工厂。内置 Pack 冻结环境、argv 与权限参数；工厂不再读取宿主环境。环境值和原始 argv 不进入 manifest。Candidate 临时目录实际启动时创建，client close 时清理；清理失败不吞掉，未创建的目录不当作自己拥有。Host shell 在工具装配时冻结选用环境和挂载覆盖，复用原 invocation home 作为临时目录。

RunManifest 的可选 executionBoundary 保存启动时 Host 配置与 Pack 声明。原生确认仅来自结构化产品输出，位于 runtime.session_started 的可选 executionObservation，不回写 manifest。Codex 仅在 thread/start 返回明确 sandbox 字符串时记录；缺失或其他形态保持未知。Claude 在 init 报告已知 permissionMode 时记录；init 可能晚于首次消息，冲突时停止后续执行，不能称为启动前阻断。显式 argv 覆盖不能认证 Claude 默认参数已配置，其原生模式保持未知。

明确要求文件隔离、禁止全部扩展或不匹配的原生权限时，规划失败且不创建子进程。缺少规划能力的旧 Pack 不得认证显式要求。普通 EPERM、exit 1、超时仍为执行故障；原生 permission_denials 沿既有事件与产品投影保存。不新增宽权限重试或通用拒绝恢复。

## 备选方案

**仅过滤调用方环境**：Runner 再合并宿主环境会恢复已删除的变量，不能形成有效收敛。

**全局替换共用 spawn**：会将 Candidate 的认证规则施加到浏览器等其他角色，破坏既有入口。

**引入 OS 沙箱后端**：属于后续独立验证范围，不能用本阶段环境过滤冒充系统隔离。

## 影响

端口及持久化字段均为可选扩展，旧 Pack 的 createRunner 和旧记录保持可读；缺少记录显示未记录/未声明，不以当前设置补写。原 executionIsolation 仍是独立 Pack 声明。TUI 启动 timeline 和结果、报告的 Host 区域只投影记录。Comparison 新事实随已有 comparison.requested 与 briefing 持久化，可重建模型输入。

这是可信本地模式：允许列表和副本不限制磁盘读取、网络、共享用户配置、hooks/skills/agents 等加载，也不实现盲测。保留原生权限默认值，不提供 OS 沙箱模式或新审批界面。宽权限 Candidate 仍可能自行尝试替代命令。

## 验证

离线验证使用 fake Runtime、本机子进程、假认证和代理值，覆盖 Runner 不回灌、持久化脱敏、Host shell 冻结、原生模式冲突后停止、临时目录清理及旧记录兼容。执行源码 build、相关测试与 npm run check。真实 Codex/Claude 登录、网络、版本兼容与原生隔离须另行显式 opt-in；离线测试不认证这些能力。

当前规则见[执行](../../architecture/execution.md)、[架构](../../architecture/overview.md)和[运行说明](../../usage.md)。
