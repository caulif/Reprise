# 决策：标准 Runtime 事件与用户可见回合

状态：accepted

延续 [ProductPack 端口](./2026-09-09-product-pack-ports.md) 与 [LaunchContext](./2026-09-09-candidate-launch-context.md)。目标见 [Application 与候选链重构](../../plan/application-candidate-agent-refactor.md) 阶段 E–F。

## 问题

候选 Session 的交付、settlement 和用户可见输出散落在产品私有事件里。Application 若解析产品帧，Controller 输入就会混入流式中间内容，也无法在 Fake Runner 上单独验收生命周期。

## 决定

`ProductRuntime.createRunner` 必须接收已准入的 `CandidateLaunchContext`，并在 `workspaceRoot` 启动新 Session。`TargetRunner` 提供 `session`、`start`/`send`、delivery、原生 `waitForTurn`、必选 `cancelWait`、`inspect`、`stop` 和 `close`。

标准化事件以 `CandidateRuntimeEvent` 描述（eventId、单调 sequence、时间、sessionId、可选 turn/message/call、payload、evidenceRefs）。产品 Adapter 先映射为 `runtime.<CandidateRuntimeEventType>`，Journal 只接受该集合；流式 delta、心跳、stderr 与隐藏 reasoning 留在 Adapter 内。Application 不解析产品私有帧。

只在原生 settlement 之后由 `UserSurfaceProjection.projectTurn` 生成 `UserVisibleTurn`。投影失败记为 `unavailable`，不得当成空输出。持久化 `controller-briefing/current-user-view.md` 与 `run/turns/{n}/user-view.md`。流式 `translate` 只写公开活动，不作为 Controller 决策输入。

## 备选方案

**Application 直接读 Codex/Claude 私有事件。** 每个产品一套 Controller 输入，无法用 Fake 闭环验收。

**把 user-view 只放在 view.txt。** 缺少不可变每轮 Markdown 与 schema 校验对象，Comparison 无法按回合引用。

## 影响

产品 Adapter 仍封装 CLI/IPC；新增端口方法不得省略。TUI 正式时间线只消费已持久化的 `UserVisibleTurn`。

## 验证

`test/fake-target-runner.test.ts` 覆盖 Fake 交付与 settlement 模式、session/close、投影确定性。`test/controller-briefing.test.ts` 断言 user-view 文件。`npm run check` 必须通过。
