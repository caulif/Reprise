# 支持

## 当前阶段

Reprise 是本机优先的个人任务对照工具。Windows 11 是唯一经过真实使用验证的平台；macOS/Linux 的真实终端与 Runtime 尚未得到同等验证，不能称为已支持。

CI 在 Windows、macOS、Ubuntu 运行模拟测试，具体矩阵以 [check.yml](../.github/workflows/check.yml) 为准；TUI 帧审计使用 Windows 基线。CI 绿灯不证明三平台的真实 Runtime、文件权限或终端 IME、滚轮、拖选均已验证。边界与待补证据见[本机平台规范](./architecture/platform-and-packs.md#12-本机平台边界)及[平台证据矩阵](./plan/2026-09-08-platform-evidence-matrix.md)。

Node 要求以 [package.json](../package.json) 的 engines 为准。默认开发验证与 CI 不运行真实 Runtime smoke，不产生模型调用费用；真实 smoke 必须经环境变量显式 opt-in，见[准入程序](./codex-smoke-gate.md)。实际产品任务可能计费，费用由操作者自行确认并承担。

## 怎么提问

先读[入门说明](../README.md#从源码开始)与[产品定义](./product/overview.md)，并搜索已有 Issue。仍有问题时，通过仓库 Issues 选择合适的 [Bug / Feature / Task 模板](../.github/ISSUE_TEMPLATE/)。

Bug 请提供版本或提交、Node/OS/终端信息、最少步骤、预期与实际结果，以及脱敏命令和退出码。优先提供不调用真实 Runtime 的复现；确实依赖真实调用时说明原因及未验证范围，不要求他人为排查承担费用。功能建议说明用户问题、非目标与替代方案。

## 支持边界

项目由单人维护，不承诺响应时限、商业支持、公共榜单或代付模型费用。不提供产品账号登录、凭据读取或重置服务，也不能回滚隔离目录以外的外部副作用。

不得把原始会话、认证文件、API key 或含隐私的截图直接附到 Issue。漏洞走[安全政策](./SECURITY.md)的私下渠道；行为问题按[行为准则](./CODE_OF_CONDUCT.md)报告；维护与权限边界见[治理说明](./GOVERNANCE.md)。
