# 日常开发

本文集中记录本地操作，贡献流程见[贡献指南](./CONTRIBUTING.md)，检查范围与失败语义以[工程门禁](./engineering-gates.md)为准；脚本名称以 [package.json](../package.json) 为准。

## 准备环境

需要 Git、Node.js（版本见 [engines](../package.json)）与 npm。在仓库根目录运行 `npm ci` 安装锁定依赖，再运行 `npm run build`。构建会重建 `dist/`；CLI 体验见[根 README](../README.md#从源码开始)。默认开发验证不要求产品登录或模型密钥。

Windows 11 是唯一经过真实使用验证的平台，其他平台的 CI 模拟测试范围见[支持说明](./SUPPORT.md)。路径拼接和进程启动按 Windows 优先，`.cmd` 启动约束见[根指令](../AGENTS.md)。

## 验证命令

| 意图或改动面 | 命令与使用条件 |
|---|---|
| 仅文档（含根 README、GitHub 协作文档） | `npm run verify:docs`，不默认跑全量或真实 smoke |
| 代码迭代中快速反馈 | `npm run check:fast`；不是代码改动的收尾检查替代品 |
| 改代码后的收尾检查 | `npm run check`，包含 build、lint、typecheck 等，范围由[编排源码](../scripts/run-gates.mjs)拥有 |
| 聚焦某个回归 | `npm run build` 后运行 `node --test` 并传入对应的 `dist/test/` 下 `.test.js` 路径 |
| 全部测试 | `npm test` 自动构建；只有构建与源码同步时才用 `npm run test:only` |
| 单独定位静态错误 | `npm run lint` 或 `npm run typecheck`；类型检查不代替 lint |
| Schema 生成区 | 修改源后 `npm run build`、`npm run gen:docs`、`npm run verify:generated`，收尾仍跑 `npm run check` |
| Pack / Runtime / 凭据 | `npm run check` 并补相关 fixture 回归，不默认调用真实 Runtime |
| TUI 渲染 | `npm run audit:tui:check`；Windows 比对帧基线，其他宿主只生成与自检；代码收尾仍跑 `npm run check` |
| 覆盖率 / 发布前检查 | 按[工程门禁](./engineering-gates.md)选择 `npm run test:coverage` / `npm run check:full`，不为每次改动叠跑 |

测试读取构建产物，不能直接用 `node --test` 跑 TypeScript。源码或测试变化后先构建；例如对 [CLI 测试](../test/cli/cli.test.ts)做窄回归：

```text
npm run build
node --test dist/test/cli/cli.test.js
```

生成文档与 TUI 快照的维护规则见[工程门禁](./engineering-gates.md)；不要手改生成区，或在非 Windows 宿主重写 Windows 基线来消除差异。

## 费用与验证证据

默认开发验证与 CI 不运行真实 Runtime smoke，不产生模型调用费用。真实 smoke 需要环境变量显式 opt-in，并满足[准入程序](./codex-smoke-gate.md)；普通测试和 fixture 不能冒充真实验证，未运行就是未验证。

记录实际命令、退出码、Node/OS、受影响测试及未跑原因。红灯先定位与修复，不放宽阈值或改为非阻断；日志和产物须按[安全政策](./SECURITY.md)去除敏感内容后再分享。

需要操作步骤时见[验证一次改动](./cookbook/verify-change.md)与[新增或更新 ADR](./cookbook/add-adr.md)。
