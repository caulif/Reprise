# Reprise

Reprise 是一个 local-first Harness，用于在真实任务上比较 Agent Runtime。项目保留一条可重复的 fixture + `ScriptedRuntime` 开发路径，也已验证当前 Codex app-server 的真实协议 smoke。

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

fixture 路径不调用 provider：

```text
node dist/src/cli/main.js setup --data-dir .reprise --fixture test/fixtures/codex-session.fixture.json
node dist/src/cli/main.js cases --data-dir .reprise
node dist/src/cli/main.js compare --data-dir .reprise --case <caseId> --model fixture-model
node dist/src/cli/main.js report --data-dir .reprise --experiment <experimentId>
node dist/src/cli/main.js smoke-record --data-dir .reprise --experiment <experimentId> --record <acceptance.json>
```

## 真实 Codex protocol smoke

先执行一次构建，然后用明确的环境变量和**绝对**数据目录运行。该目录保存不可变 `TaskCase`、Experiment trace、`RunRecord`、报告和验收记录；建议放在临时目录或 `.reprise-*` 目录（已被 Git 忽略）。

```powershell
npm run build
$env:REPRISE_RUN_CODEX_SMOKE = '1'
node scripts/codex-real-smoke.mjs --data-dir 'C:\absolute\reprise-real-smoke'
```

脚本执行一条无工具的固定文本任务，候选使用 Luna/high；Terra/medium 负责一次 Controller 决策和 Comparison。Controller 若发送文本 follow-up，脚本最多提交一次；Comparison 始终按 schema 和 evidence refs 校验，模型输出不合格时保留持久化事实并安全降级。app-server 仍不会获得工具或权限批准。详细准入、证据和限制见 [Codex smoke gate](./docs/codex-smoke-gate.md)。

项目使用单一 TypeScript/ESM 包；`src/cli` 是 fixture CLI 的 composition root，真实 protocol smoke 保持为一份显式运行脚本，避免把受控验证扩展为通用 benchmark CLI。
