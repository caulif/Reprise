# 第三轮分模块审视

日期：2026-08-13
方法：逐模块重读当前源码；`npm run typecheck` 通过，`npm test` 64/64 通过。

## 总体结论

上一轮的遗留项基本清完了：伪哈希、死配置字段、capabilities 错配、占位 payload、`validateCandidate` duck-typing、重复原语、双配置并存全部消失；Recovery Agent 选择了"收缩"路线整体删除；`wallClockMs` 起点修正；TUI 现在支持选择任务起点消息。**架构主干目前是干净、自洽的，本轮没有发现设计层面的问题。**

本轮发现 **1 个真实 Bug**（TUI 时间线与生产事件 payload 形状错配，真实运行时 Controller 决策显示为 UNKNOWN），以及一批删除性质的死代码残留——多数是 Recovery 删除后留下的"断骨"。无需要新增抽象的建议。

---

## P0：一个真实 Bug

### timeline 投影读错了生产事件的 payload 形状

生产路径写入的 `controller.decision` 事件 payload 是 `invocationFact(decision)`，即：

```246:247:src/application/codex-experiment.ts
    decisions.push(decision);
    await input.store.append({ type: 'controller.decision', runId: input.runId, operationId: `controller-decision-${controllerCalls}`, payload: invocationFact(decision) });
```

也就是 `{ status, sessionId, value: { type: 'send', message, rationale, … } }`——决策内容嵌在 `value` 里。而 `timeline.ts` 直接读顶层字段：

```78:87:src/tui/timeline.ts
function controllerEntries(event: EventEnvelope, payload: JsonRecord): readonly TimelineEntry[] {
  const kind = text(payload.type) ?? 'unknown';
  const rationale = text(payload.rationale);
  // ...
  const message = text(payload.message);
```

结果：**真实运行中每个 Controller 决策在 TUI 时间线显示为 `Decision: UNKNOWN`，没有 rationale，也不显示发给 Target 的消息**。同样地，`controller.done` 的生产 payload 是 `{ reason }`（`candidate-run.ts` 第 85 行），timeline 读 `payload.decision` → 恒显示 `Done: unknown`。

测试没抓住是因为 `timeline.test.ts` 和 `codex-intake.test.ts` 喂的是投影器假设的扁平形状（`payload: { type: 'send', … }`），而不是生产者的真实形状——测试镜像了消费者的假设，而不是生产者的契约。

**修复建议（半小时）**：timeline 改读 `record(payload.value)`（completed 时）并对 `controller.done` 读 `payload.reason`；两个测试的 fixture 换成 `invocationFact` 的真实输出形状。不建议反向改 producer——`invocationFact` 的包裹形状是审计事实，是对的。

---

## P1：死代码清单（Recovery 删除后的断骨，约半天）

这些都是纯删除，`noUnusedLocals` 开关能防止复发：

| 位置 | 残留 | 处理 |
|---|---|---|
| `schema.ts` 第 2 行 | `import { Value }` 未使用 | 删 |
| `schema.ts` 第 35–39 行 | `EnvironmentBaselineSchema` 已无引用（`TaskCase` 不再含 `environmentBaseline` 字段） | 删 |
| `pi-model-caller.ts` 第 2 行 | `import { Type } from 'typebox'` 未使用，且 `typebox` 不在 package.json（幽灵依赖，靠 pi 的传递依赖才解析成功） | 删 |
| `agent-tools.ts` `readOnlyTools` | src 与 test 均无调用者 | 删（连带 `read_workspace` 分支） |
| `pi-agent-host.ts` `AgentCapability` | `write_staging` / `run_staging_command` / `network_request` 随 Recovery 死亡；`read_workspace` 随 `readOnlyTools` 死亡 | 枚举收窄到 `read_observation` / `read_artifact` / `read_transcript` |
| `codex-experiment.ts` 第 429–431 行 | `resolvedAgentConfig(config) { return config; }` 恒等函数残壳 | 内联删除 |
| `codex-experiment.ts` 第 440 行 | `assertIds` 内联正则，未用 `identity.SAFE_ID` | 换成 SAFE_ID |
| `codex-experiment.ts` 第 405 行 | `preflightFromBaseline(_taskCase, …)` 参数已不用 | 删参 |

建议顺手在 `tsconfig.json` 加 `"noUnusedLocals": true, "noUnusedParameters": true`——本轮三处未使用导入都能被它拦下。

---

## P2：观察与小修（按需）

**1. capabilities 是纯声明，从不生效。**
`PiModelCaller.createSession` 的实现签名直接忽略 `capabilities`；真正的权限边界一直是 tools 列表本身（这个边界是实的、好的）。当前唯一作用是写进 `agent.session_started` 审计事件。Comparison agent 声明了 `read_transcript` 但实际工具是 `read_observation`（transcript 通过它的 `source: 'transcript'` 访问）。两个克制的选择：把 capabilities 定义为"注册工具名的投影"（创建 session 时从 tools 推导，删掉手写声明），或干脆删掉这个字段只留 toolNames 审计。不建议为它加执行期校验——工具列表已经是白名单。

**2. `#loadSessions()` 没有错误处理（TUI 唯一裸奔的异步入口）。**
`#loadHistory` / `#inspect` / `#freeze` / `#startExperiment` 都有 try/catch 落到 error 页，唯独 `#loadSessions` 没有。`sessionsRoot` 遇权限错误（非 ENOENT）时 `rolloutPaths` 会抛出 → `void this.#loadSessions()` 变成 unhandled rejection，整个 TUI 崩溃。补一个与兄弟方法一致的 catch 即可。

**3. 根目录卫生：文件已 ignore 但未删。**
13 个 `.typecheck*` / `.errors*` / `.tmp-interfaces.txt` 仍在磁盘上（git 已忽略，克隆者看不到）；9 个 `.gitkeep` 仍被 git 跟踪，而所在目录早已非空。均可直接删。

**4. `package.json` description 与新定位不一致。**
README 已改为"重放与检视 Agent Runtime，而非评判优劣"，但 package.json 仍是 "Local-first harness for **comparing** agent runtimes"。一行对齐。

**5. `defaultHarnessModelConfig()` 返回 schemaVersion 1。**
新代码的默认值是旧版本形状，靠读路径 normalize 兜着。直接返回 v2 形状（`provider: { kind: 'pi-catalog', id: 'openai-codex' }`），少一条隐式依赖。

**6. `historicalCommit` 采集了但仍无任何消费者。**
Recovery 已删，"兑现 replay-from-commit"的路线也随之关闭，作为纯证据留在 `taskContext` 里可以接受。一个零成本的兑现方式：报告 Historical 列已经展示 commands/touchedPaths，把 `historicalEnvironment.cwd.git`（head/dirty）和 `historicalCommit` 也列进去，用户能直观看到"历史起点是哪个 commit、重放起点是否干净"。这正是 P0-4 固定标注的那条 limitation 的量化版本。

---

## 遗留未做（上轮已知，维持原判）

- **`validateCandidate` 双 spawn**：TUI preflight 与 start 各调一次 `listModels`（各 mkdtemp + spawn 临时 app-server）。每次实验多付一次进程启动成本，正确性无损。真实跑通几次后若体感明显再做目录缓存。
- **会话经济**：Controller 持久 session + 每轮全量重发 `task.initialInput`/`baseline`。maxModelCalls=3 时浪费有限，观察真实 token 消耗后再决定。
- **token_count 模糊匹配求和**：`event.type.includes('token_count')` 累加所有轮次值，若 Codex 通知是累计值会高估。首次真实运行时对照原始事件确认语义（此项与上一条可以在同一次真实 smoke 里一起验证）。

## 克制提醒

本轮修改整体质量高：删除多于新增（Recovery 整体移除、schema 收窄、identity 收敛），没有引入新抽象。上表除 P0 外全部是删除或一行对齐性质。P0 的 timeline 修复也应止步于改读 `payload.value`，不要为"事件 payload 契约"引入 schema 层——`invocationFact` 的输出形状稳定且只有两个消费者。
