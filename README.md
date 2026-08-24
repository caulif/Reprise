# Reprise

Reprise 是一个 local-first Harness，用于在真实任务上重放与检视 Agent Runtime，而非评判优劣。项目通过最小确定性单元测试覆盖核心流程，并保留当前 Codex app-server 的真实协议 smoke。

## 已验证的真实配置

- 候选 Runtime：`gpt-5.6-luna`，reasoning effort `high`。
- Experiment Application（Controller、Comparison）：`gpt-5.6-terra`，reasoning effort `medium`。
- Runtime 拒绝所有 app-server 发起的工具/权限请求；真实 smoke 在 Harness 拥有的隔离工作区中运行。

真实 smoke 是协议与证据链验证，不是历史任务 benchmark：它不会宣布模型胜者，且模型解析仍可能记录为 `unknown`。

## 要求

- Node.js `>=22.19.0`
- Windows 11 是第一版唯一已验证的平台。
- 已安装并登录当前 Codex；Reprise 不安装 Codex，也不读取或保存凭据。

## 本地开发

```text
npm install
npm run check
```

## Benchmark TUI

`reprise`（或 `reprise --data-dir <dir> --sessions-dir <dir>`）启动 Home-first 的本地工作台，而不是通用 Coding Agent。键盘闭环仅为：

```text
/config → /intake → /run → /history
```

- `/config` 保存 OpenAI-compatible endpoint、模型、effort 和 `env:NAME` 密钥引用；密钥值不会写入 Reprise 文件。`[s]` 只做本地保存，`[t]` 才会明确发送最小连通性请求。
- `/intake` 只浏览本地 Codex 历史会话，用户确认后冻结为当前 `TaskCase`。
- `/run` 只运行当前 `TaskCase`，要求用户明确输入基线源目录、完成 preflight，并确认可能的网络费用。Reprise 会复制所选目录；隔离副本不是隐私清洗。运行前请确认目录中没有不应被读取或发送的敏感文件。
- `/history` 只读浏览已冻结的 TaskCase 和本地实验，显示每个实验及全部数据目录占用；详情可选择当前案例或按 `o` 打开生成的报告。

所有本地数据都位于数据目录的 `cases/` 和 `experiments/` 下。Reprise 不提供批量删除按钮；需要回收空间时，先退出 Reprise，再手动删除不再需要的 `experiments/<experiment-id>/` 或 `cases/<case-id>/` 目录。

无 slash 的文本不会发送给模型或修改当前工作区。`Esc` 返回 Home/丢弃未保存配置草稿；`Ctrl+C` 在运行中请求取消，首次提示等待收尾；收尾期间再次按 `Ctrl+C` 强制退出。关闭 TUI 会取消 active run；第一版不支持 detach/reattach。其他状态退出并恢复终端。

## 真实 Codex protocol smoke

这是一个明确 opt-in 的无工具 app-server 文本协议探针；它不创建实验、不读取工作区，也不替代需要 Host 工具的完整 TUI 实验。

```powershell
$env:REPRISE_RUN_CODEX_SMOKE = '1'
npm run smoke:codex
```

脚本只验证 Terra/medium 经当前 Codex app-server 完成一次无工具文本往返，并严格校验固定响应。`CodexTextCaller` 不能把 Host 工具暴露给 app-server，因此它不会伪装成 Controller/Comparison 的完整实验 smoke；完整实验仅通过 TUI 的已配置 Pi Harness 启动。

项目使用单一 TypeScript/ESM 包；`src/cli` 仅负责启动 TUI，真实 protocol smoke 保持为显式运行脚本，避免把受控验证扩展为通用 benchmark CLI。

## 协作

贡献、验证命令和真实 smoke 边界见 [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)。漏洞请按 [`docs/SECURITY.md`](./docs/SECURITY.md) 私下报告。支持范围见 [`docs/SUPPORT.md`](./docs/SUPPORT.md)。

## 文档

产品定义、当前架构、研究依据和历史归档都在 [`docs/`](./docs/README.md)，本文件是仓库根目录唯一的 Markdown 入口。
