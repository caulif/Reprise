# 支持

## 当前阶段

Reprise 是 local-first 个人对照工具。产品支持平台是 **Windows 11**；Node.js 要求见根 [`package.json`](../package.json) 的 `engines`。CI 另在 Ubuntu 上跑 Node 测试作为可移植性门禁，但不承诺真实 Runtime、TUI 帧或其他 OS 上的产品行为。不承诺公共榜单，不承诺替你承担真实 Runtime 费用。

## 怎么提问

1. 先搜索已有 Issue。
2. 用 Bug / Feature / Task 模板新建 Issue；Bug 必须能在未 opt-in 真实 smoke 的前提下给出复现或说明为何必须真实 smoke。
3. 用法与产品边界见 [`product/overview.md`](./product/overview.md)。

## 不要指望这里解决的事

- 在默认 CI 或未设置环境变量的情况下替你跑 Codex / Claude 真实调用。
- 读取或重置你的 Codex / Claude 凭据。
- 回滚你在隔离工作区之外造成的外部副作用。

安全问题走 [SECURITY.md](./SECURITY.md)。治理与决策方式见 [GOVERNANCE.md](./GOVERNANCE.md)。
