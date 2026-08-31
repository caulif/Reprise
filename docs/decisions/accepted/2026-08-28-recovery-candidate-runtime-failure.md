# 决策：候选 Runtime 失败分类与恢复门禁解耦

状态：accepted

## 问题

会话恢复完成后启动候选，上游模型请求返回 HTTP 503，Codex 重连数次后 `turn/completed(status=failed)`。Harness 正确进入 `failed.runtime`，但结果页只有 `Target turn settled as failed.`，运行页也不展示重连。用户把正常的上游等待当成程序卡死。恢复阶段的 source `blockedReasons` 还会再次拦住已经有可运行 recovery candidate 的启动。

## 决定

`TurnSettlement` 携带可选、已脱敏的 `failure`（`kind` / `summary` / `retryable` / `reconnectCount`）。Codex `turn/completed` 与 `CodexTextCaller` 共用同一分类：HTTP 503 为 `upstream` 且可重试。`termination.code` 保持 `failed.runtime`；细分类写入 `failure.code`。未知 turn 状态立即失败；进程退出立即唤醒 waiter。`thread/start` 失败会关闭 app-server 并删除临时目录。有 accept/staging 的 recovery candidate 不再被恢复前 source `blockedReasons` 拦截。TUI 区分恢复与候选阶段，展示重连与等待告警。初版不对 503 自动重试。

## 备选方案

**缩短 turnTimeoutMs 把 503 当成超时。** 会把正常的慢 turn 误报为失败，也无法给出上游原因。

**把候选 `failed` 记成恢复失败。** 恢复与候选是两条调用链；partial 恢复后候选仍应可启动。

**对 503 自动无限重试。** 增加费用，并把界面卡在同一 run id 上。

**删除 source workspace 安全边界以保证启动。** 候选仍须跑在隔离环境；解耦的是门禁，不是隔离。

## 影响

- 报告与 settlement 不得包含 API key、Authorization、完整 prompt 或完整 upstream URL。
- 认证/协议失败不标为可重试；用户手动重新启动会创建新的 run id。
- Recovery Agent 的模型状态不得冒充候选模型状态。

补充记录（2026-08-29）：失败运行还暴露出一个独立问题：旧默认候选仍固化为 `gpt-5.6-luna`，而当前本机 Codex 配置使用 `gpt-5.6-terra`。即使 preflight 得到 `resolvedModel`，Runner 之前仍把 `requestedModel` 发送给 `thread/start` 和 `turn/start`，因此上游返回 404。生产默认候选已切换为 Terra；Runner 现在优先使用已解析模型，并在后续 turn 使用 `thread/start` 返回的实际线程模型。旧运行记录保留为历史事实，新运行必须重新创建，不能通过修改旧 manifest 伪造修复。
## 验证

- `test/codex-pack.test.ts`：503 分类、脱敏、重连计数、未知状态、进程退出、thread/start 清理。
- `test/candidate-run.test.ts`：`failed.runtime.upstream_unavailable` 与 cleanup complete。
- `test/tui-workflow.test.ts`：blockedReasons 不拦有效 candidate。
- `test/widgets.test.ts`：候选标题、重连文案、结果页「上游服务暂时不可用」。
