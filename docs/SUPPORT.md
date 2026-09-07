# 支持

## 当前阶段

Reprise 是 local-first 个人对照工具。Windows 11 是现有主要真实验证平台；CI 在 Windows、macOS、Ubuntu 运行模拟测试，配置见 [check.yml](../.github/workflows/check.yml)。这不证明各平台真实 Runtime、文件权限或 TUI 均已验证。三平台本机任务是[重构目标](./plan/reprise-architecture-redesign.md)，正式支持需要逐平台证据。

Node 要求以 [package.json](../package.json) 的 engines 为准。平台与 shell 当前行为见[本机平台边界](./architecture/cross-platform.md)。不承诺公共榜单或承担用户的模型费用。

## 怎么提问

1. 先搜索已有 Issue。
2. 用 Bug / Feature / Task 模板新建 Issue；Bug 必须能在未 opt-in 真实 smoke 的前提下给出复现或说明为何必须真实 smoke。
3. 用法与产品边界见 [`product/overview.md`](./product/overview.md)。

## 不要指望这里解决的事

- 在默认 CI 或未设置环境变量的情况下替你跑 Codex / Claude 真实调用。
- 读取或重置你的 Codex / Claude 凭据。
- 回滚你在隔离工作区之外造成的外部副作用。

安全问题走 [SECURITY.md](./SECURITY.md)。治理与决策方式见 [GOVERNANCE.md](./GOVERNANCE.md)。
