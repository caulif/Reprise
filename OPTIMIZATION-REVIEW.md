# Reprise 全流程与核心模块优化意见

审阅日期：2026-08-13
代码基线：`src/` 约 4,500 行 TypeScript，28 个源文件；`npm run typecheck` 干净，`npm test` 64/64 通过。

本文只记录**已在代码中核实**的问题。每条都给出文件与行号，以及具体改法。它与 `FIRST-PRINCIPLES-REVIEW.md`（产品层面的第一性原理审视）互补：那份文档问"这个产品该不该做、做什么"，本文问"现有实现哪里会出错、哪里在腐化"。

---

## 一、总体判断

Reprise 的架构骨架是**扎实**的，有几处明显高于同规模项目的平均水平：

- **事实与推断严格分离**。`AgentInvocation<T>` 在失败时刻意不带 `T`（`src/infrastructure/pi-agent-host.ts:20-24`），Host 绝不替模型编造领域值。`finishExperiment` 甚至会在 Comparison 声称完成但没真写出 `comparison.md` 时把结果降级为 `agent_failure`（`src/application/codex-experiment.ts:199-201`）。这个约束在整个代码库里被一致地执行。
- **不可变写入与事件溯源**。`writeImmutableJson` 用 tmp + `wx` + rename 的正确原子模式；事件带 checksum 和 sequence 连续性校验；`operationId` 提供幂等。
- **安全边界清晰**。app-server 发起的一切请求一律拒绝（`src/products/codex/runtime-port.ts:156-160`）；工具路径拒绝绝对路径、拒绝逃逸、拒绝 symlink、拒绝凭据文件（`src/infrastructure/agent-tools.ts:70-89`）；API key 只以 `env:NAME` 引用形式持久化，值不落盘。

主要问题不在骨架，而在**三个方向的腐化**：

1. **资源生命周期没有收口**——定时器不清、子进程 RPC 无超时、锁无 stale 回收。这些在 fixture 测试里都看不出来，只在真实长跑中暴露。
2. **接口契约被一个实现悄悄破坏**——`CodexTextCaller` 与 `PiModelCaller` 实现同一个 `PiTextCaller`，但语义完全不同，直接导致 Controller 的工具与对话记忆在真实 Codex 路径上失效。
3. **未纳入类型检查的边缘代码已经漂移**——`scripts/*.mjs` 传的参数有一半是当前 `src` 不认识的。

---

## 二、全流程地图

### 三个入口，三套装配

| 入口 | 位置 | Runtime | Agent | 用途 |
|---|---|---|---|---|
| `reprise tui` | `src/cli/main.ts:164-176` → `codex-tui-workflow.ts` | `CodexRuntimePort` 真实进程 | `PiModelCaller`（Pi/OpenAI 兼容） | 生产主路径 |
| `reprise compare` | `src/cli/commands.ts:65-104` | `ScriptedRuntime` 假运行时 | 硬编码离线桩（`commands.ts:192-197`） | 确定性回归 |
| `scripts/codex-real-smoke.mjs` | `scripts/codex-real-runner.mjs:17-48` | `CodexRuntimePort` | `CodexTextCaller`（走 Codex app-server） | 协议 smoke |

三条路径各自组装 `startCodexExperiment`，参数不共享、默认值不共享。这是后面若干漂移问题的根源。**第六节给出了把三套装配收敛成一套的具体方案**，它从结构上消除这类漂移，建议优先于单点修补执行。

### 端到端阶段（以 TUI 为准）

```
/config  → harness-model.json（provider / model / effort / env:KEY 引用）
   ↓
/intake  → discoverCodexSessions 扫描本地 rollout JSONL
         → inspectCodexSession 预览
         → freezeCodexSession 冻结为不可变 TaskCase（contentHash + provenance）
   ↓
/run     → preflightCodexExperiment  只读准入：校验候选模型 + inspectBaseline
         → 用户确认（明确提示可能产生网络费用）
         → startCodexExperiment
              ├ LocalWorkspaceProvider.resolveBaseline  拷贝隔离基线（拒绝 symlink）
              ├ prepareRun                              为本次 run 复制工作区
              ├ ExperimentStore.open + acquireWriter    单写者事件日志
              ├ CandidateRun 状态机
              │    created → preparing → launching → awaiting_target
              │              ⇅ awaiting_controller（Controller 决策循环）
              │              → finalizing → finished
              ├ runControllerLoop                       三重预算：wallClock / maxModelCalls / maxConsecutiveNoProgress
              ├ captureWorkspaceScope                   释放工作区前固化 changedPaths + 文本快照
              ├ comparePersistedFacts                   Comparison Agent 只读证据、写 comparison.md
              └ renderComparisonReport                  report.html
   ↓
/history → 只读浏览已冻结 TaskCase 与实验
```

这条链路的设计意图是清晰的：**每一步都先落盘事实，再让模型解读事实**。`inspectRun`（`codex-experiment.ts:266-293`）确定性地把事件压缩成摘要，不含任何模型推断——这是对的。

---

## 三、P0：会在真实运行中出错的问题

### P0-1 `timeoutAfter` 的定时器从不清理，进程退出被挂起最多 10 分钟

`src/application/candidate-run.ts:149-152, 303-305`

```ts
const settlement = await Promise.race([
  this.#runner.waitForTurn(),
  timeoutAfter(this.#policy.turnTimeoutMs),
]);
...
function timeoutAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('turn timeout')), milliseconds));
}
```

`waitForTurn()` 赢得 race 后，那个 `setTimeout` 既没有 `clearTimeout` 也没有 `unref()`。Node 会为未决定时器保持事件循环存活。

实际后果，按各入口的 `turnTimeoutMs` 计算：

- TUI（`codex-tui-workflow.ts:32`，`turnTimeoutMs: 10 * 60_000`）：用户 `Ctrl+C` 退出 TUI 后，进程最多再挂 **10 分钟**才退出。终端看起来是卡死的。
- smoke 脚本（`scripts/codex-real-smoke.mjs:28`，`turnTimeoutMs: 90_000`）：脚本打完最后一行 JSON 后再挂 **90 秒**。脚本末尾只设 `process.exitCode`、不调 `process.exit()`（`codex-real-smoke.mjs:76`），所以完全依赖事件循环排空。
- 每个 turn 各留一个定时器，`maxTargetTurns: 4` 就是 4 个。

fixture 测试之所以看不出来，是因为 `commands.ts:216` 把 `turnTimeoutMs` 设成了 1000ms。

**改法**：

```ts
async #raceTurn(): Promise<TurnSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      this.#runner.waitForTurn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('turn timeout')), this.#policy.turnTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

`AgentSessionHost.request` 里已经用 `finally { clearTimeout(timer) }` 做对了（`pi-agent-host.ts:183-186`），这里只是漏了。

---

### P0-2 `CodexTextCaller` 破坏 `PiTextCaller` 契约：工具不注册、对话不延续

这是最影响正确性的一条，因为它让 Controller 在真实 Codex 路径上**静默降级**。

`PiTextCaller.createSession` 接收 `tools` 与 `capabilities`（`src/infrastructure/pi-agent-host.ts:50-57`）。两个实现的行为：

| | `PiModelCaller` | `CodexTextCaller` |
|---|---|---|
| 注册 `tools` | 是，`tools: input.tools.map(toPiTool)`（`pi-model-caller.ts:91`） | **否**。`input.tools` 在整个文件中再未被引用 |
| 使用 `capabilities` | — | **否**。传给 `#complete` 后在函数体内未使用（`text-caller.ts:48`） |
| 保留对话历史 | 是，`Agent` 持有 `state.messages`（`pi-model-caller.ts:101`） | **否**。每次 `append` 都 `mkdtemp` + spawn 新进程 + `thread/start` 全新线程（`text-caller.ts:52-80`） |

后果有两层：

1. `ControllerAgent` 按 runId 缓存 session（`controller-agent.ts:56-61`），设计意图写在 `AgentSessionHost` 的注释里——"One isolated model transcript. A Controller retains one of these per CandidateRun."（`pi-agent-host.ts:121`）。走 `CodexTextCaller` 时这个 transcript 是假的，Controller 每一轮都是失忆的，它无法感知"我上一轮已经问过这个了"。而 `runControllerLoop` 的 `maxConsecutiveNoProgress` 恰恰是用来兜住重复提问的（`codex-experiment.ts:250-252`）——这说明失忆的代价已经被观察到，只是被当成症状治了。
2. `runControllerLoop` 每轮都把 `observationTools(...)` 传给 `controller.decide`（`codex-experiment.ts:244`），Controller 的 system prompt 也明确说"You may inspect only Host-provided observations and evidence"。走 `CodexTextCaller` 时这些工具根本不存在，Controller 只能看 `currentSummary`/`trajectorySummary` 两个字符串。

同时这里还有性能代价：每次修复重试都要重新 spawn 一个 Codex 进程 + 建临时目录。

**改法**（按投入排序）：

- 最小止血：`CodexTextCaller.createSession` 在 `tools.length > 0` 时直接抛错，把静默降级变成显式失败。这样至少不会有人误以为 Controller 用上了工具。
- 正确修法：让 `createSession` 持有一个长生命周期的 `CodexAppServerClient` 与单个 `threadId`，`append` 复用同一 thread（`turn/start` 多次），`cancel` 时才 `close`。工具通过 app-server 的工具注册通道暴露；若当前协议不支持，就把这个限制写进 `PiTextCaller` 的接口文档，并让 `PiAgentHost` 在创建 session 时检查能力。

---

### P0-3 app-server JSON-RPC 没有超时，进程可以永久挂起

`src/products/codex/runtime-port.ts:108-120`

```ts
const result = new Promise<unknown>((resolveRequest, reject) => this.#pending.set(id, { resolve: resolveRequest, reject }));
try {
  this.#process.stdin.write(`${JSON.stringify(message)}\n`);
} catch (error) { ... }
return result;
```

pending promise 只有三条出路：收到匹配 id 的响应、进程 `error`、进程 `exit`（`runtime-port.ts:97-98` 的 `#failAll`）。如果 Codex 进程活着但不回包——协议 bug、内部死锁、网络层卡住——`initialize` / `thread/start` / `turn/start` 会永久挂起。

`CandidateRun` 的 `turnTimeoutMs` 只覆盖 `waitForTurn()`，不覆盖这些 request。所以 `start()` 阶段卡住是完全无保护的。

**改法**：给 `#pending` 每项挂一个定时器（`clearTimeout` 记得放在 resolve/reject 路径上），默认 60–120s，超时时 reject 并触发 `close()`。同时把 `waitForTurn` 的等待也接入同一超时体系，让 `RunPolicy.turnTimeoutMs` 成为唯一真相来源，而不是像现在这样一半在 `CandidateRun`、一半没人管。

---

### P0-4 子进程终止没有升级路径

`src/products/codex/runtime-port.ts:122-130`

```ts
if (child && child.exitCode === null && !child.killed) child.kill();
await processClosed;
```

只发一次默认信号，然后**无限期** `await processClosed`。如果子进程忽略信号（Windows 上通过 `cmd.exe` shim 启动时尤其可能，见 `runtime-port.ts:93`），`close()` 永不返回。而 `CandidateRun.#cleanup` 是 `await this.#runner.stop(reason)`（`candidate-run.ts:191`），整个实验会卡在 finalizing。

**改法**：`kill()` → 等 5s → `SIGKILL`（Windows 上 `taskkill /F /T /PID`）；`await processClosed` 加超时兜底，超时后把 cleanup 状态标为 `incomplete` 并记录 `remainingResourceIds`——schema 里这个字段已经有了（`schema.ts:180`），目前恒为空数组。

---

### P0-5 `writer.lock` 没有 stale 检测，崩溃一次该实验目录永久锁死

`src/infrastructure/store/experiment-store.ts:118-136`

锁文件里记了 `pid`、`host`、`startedAt`、`nonce`，但 `acquireWriter` 在 `EEXIST` 时直接抛错，从不读取这些字段：

```ts
if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
  throw new Error(`Experiment ${this.#experimentId} already has an active writer.`);
}
```

`close()` 会删锁（`experiment-store.ts:138-143`），但进程被 `Ctrl+C` 强杀、崩溃、或卡在 P0-4 时不会走到。之后这个实验的 `report` 命令也起不来（`commands.ts:125` 会 open 同一个 store）。

**改法**：`EEXIST` 时读锁内容 → `host === hostname()` 且 `process.kill(pid, 0)` 抛 ESRCH 则判定 stale → 记一条 `writer.lock_reclaimed` 事件后删锁重试一次。跨主机（`host` 不匹配）保持拒绝，因为无法判定。

---

## 四、P1：架构一致性问题

### P1-1 `scripts/*.mjs` 已与 `src/` 漂移，且不被任何检查覆盖

`scripts/codex-real-runner.mjs:36-38` 传给 `startCodexExperiment` 三个参数：

```js
allowObservational: true,
...(input.currentSummary ? { currentSummary: input.currentSummary } : {}),
...(input.trajectorySummary ? { trajectorySummary: input.trajectorySummary } : {}),
```

`CodexExperimentInput`（`src/application/codex-experiment.ts:40-59`）**没有任何一个这三个字段**。它们被静默丢弃。`codex-real-smoke.mjs:30` 认真地传了 `currentSummary`，以为自己在给 Controller 提供观察摘要，实际什么也没发生。

同样，`codex-real-smoke.mjs:31,35` 读 `run.decision.usedFallback` 和 `result.comparison.result.usedFallback`。`usedFallback` 在 `src/` 中已完全不存在——它是 fallback 机制被移除时删掉的（`pi-agent-host.ts:25` 的注释"it no longer has a fallback value"就是这次改动的痕迹）。于是验收记录里 `controllerFallback` 恒为 `undefined`，最终写进不可变的 `codex-smoke-acceptance.json` 的人工判断文本是 `controller fallback=undefined`（`codex-real-smoke.mjs:69`）。

这是**验收证据被污染**，比一般的死代码严重。根因是 `.mjs` 不在 `tsconfig.json` 的 `include` 里，改 `src` 时没有任何信号。

**改法**：把这两个脚本改写成 `scripts/*.ts` 纳入 `tsc`，或至少在 `tsconfig.json` 打开 `allowJs` + `checkJs` 并把 `scripts` 加进 include。前者更好，因为 `codex-real-runner.mjs` 从 `dist/` 直接 import 的写法本身就绕开了类型系统。

### P1-2 `maxProviderRetries` 是纯装饰配置

它出现在 schema（`src/core/schema.ts:79`）、`ExperimentAgentConfig`（`codex-experiment.ts:18`）、`harness-agents.ts:13,23`、`commands.ts:200`、两个脚本里——**没有任何一处消费它**。全部赋值为 `0`。

它给人的印象是"provider 层瞬时错误会自动重试"，实际上不会：`AgentSessionHost.request` 的循环由 `maxRepairAttempts` 驱动，只针对 schema 不合规重试，遇到 429/5xx/ECONNRESET 会直接失败（`pi-agent-host.ts:180-182`）。

**改法**：二选一，不要留中间态。要么在 `AgentSessionHost.request` 里对可重试错误实现指数退避；要么从 schema 和所有配置里删掉这个字段。考虑到 `RunPolicy` 已有多重预算，我倾向于**先删**，等真的遇到瞬时失败再加。

### P1-3 保真度是硬编码的仪式

`preflightFromBaseline`（`codex-experiment.ts:405-417`）第一个参数就叫 `_taskCase`——它完全不看 TaskCase。返回的 `fidelity` 是两个常量：baseline 不可用时全 `observational`，可用时 `environment: 'observational', externalWorld: 'partially_controlled'`。

`RunRecord.fidelity` 的 schema 定义了 `matched`/`partial`/`mismatched`、`controlled`/`uncontrolled`、`strict`/`exploratory` 等一整套枚举（`schema.ts:201-207`），但真实路径上永远只产出两种组合中的一种。`defaultFidelity`（`candidate-run.ts:336-339`）里的 `environment: 'matched'` 分支在生产中不可达，因为 `codex-experiment.ts:151` 总是显式传 `preflight.fidelity`。

这一点 `FIRST-PRINCIPLES-REVIEW.md` 第 91 行已经指出过（"删除仪式性保真"）。我这里补充的是**具体的删除范围**：如果保留常量，就把 `fidelity` 从 per-run 结构降级为 experiment 级的一个 `comparisonClass` 字段加一段 `limitations` 文本，删掉 `RunRecordSchema.fidelity` 的五元组；如果要保留五元组，就必须让 `preflightFromBaseline` 真的读 `taskCase.baseline.status` 和 `baseline.fingerprint` 来定级。当前状态是最差的：付出了 schema 复杂度，没换到信息量。

### P1-4 `pi-model-caller.ts` 依赖未声明的包，且该 import 未被使用

`src/infrastructure/pi-model-caller.ts:2`

```ts
import { Type } from 'typebox';
```

`Type` 在这个文件里一次都没用到；而且 `typebox` 不在 `package.json` 的依赖里（声明的是 `@sinclair/typebox`）。它目前能解析成功，纯粹是因为 npm 把某个传递依赖提升到了 `node_modules/typebox`。换成 pnpm 的严格 node_modules 布局，或上游依赖调整，这一行就会在运行时炸。

**改法**：删掉这一行。零风险。

---

## 五、P2：可维护性与工程化

### P2-1 `CodexIntakeTui` 是 753 行的 God object

`src/tui/codex-intake.ts` 一个类里塞了 40+ 私有字段、13 个页面状态、键盘路由、异步 I/O 编排和渲染调度。三个具体的可修问题：

- **`#loadSessions` 是唯一没有 try/catch 的 loader**（`codex-intake.ts:534-539`）。`discoverCodexSessions` 在 limit 非法时会抛错，而调用方是 `void this.#loadSessions()`（`codex-intake.ts:200` 附近），会变成 unhandled rejection，TUI 停在 Home 且提示词卡在 "Discovering..."。相邻的 `#loadHistory`（408-422）和 `#inspect`（548-558）都有 catch 并跳 error 页。这一行 catch 是成本最低的修复。
- **`#runtimeDetail` 是死状态**。`codex-intake.ts:48` 声明，520/522 赋值，**从未被 `#content()` 读取**。也就是说每次进 Home 都会跑一次 `runtime.inspectAvailable()`（可能 spawn 进程探测），结果丢弃。要么在 Home 面板渲染出来，要么把这次 I/O 一起删掉。
- **所有异步 loader 都是 `void this.#loadXxx()` 的即发即忘**，没有 generation token。在 `loading` 期间按 Esc 回 Home 后，`#loadHome()` 完成时会把 `#page` 强行设回 `'home'`（`codex-intake.ts:530`），覆盖用户已经导航到的页面。连续两次 `/intake` 也会互相覆盖。

**改法**：先加 generation guard（每个 loader 开头 `const gen = ++this.#opGen`，await 之后 `if (gen !== this.#opGen) return`），这能一次性消除整类竞态；再按页面把输入处理拆成 `(state, key) => { state, effect? }` 的纯函数，控制器只负责执行 effect。渲染层的 `configForDraft`/`isEligible`（`workbench-render.ts:245,324`）是业务规则，应该从渲染模块搬走。

### P2-2 测试入口靠手工维护，漏注册没有任何信号

`test/index.test.ts` 是 13 行 side-effect import。新增 `test/*.test.ts` 必须手动加一行，否则 `npm test` 根本不跑它，而且不会失败。git 状态里曾出现过 `?? test/agent-tools.test.ts`——那个文件现在磁盘上不存在，但即便存在也不会被执行。

`agent-tools.ts` 恰好是整个项目**安全边界最集中**的文件（路径逃逸、symlink、凭据过滤、字节上限），却是零直接测试。

**改法**：`node --test 'dist/test/**/*.test.js'` 替代聚合入口，删掉 `index.test.ts`。同时补 `test/agent-tools.test.ts`，覆盖 `../` 逃逸、绝对路径、`.env`/`id_rsa` 命中 `SECRET_PATH`、symlink 拒绝、`maxBytes` 边界、以及 `evidenceTools` 的 catalog 授权（读一个不在 refs 里的 artifactId 应当被拒）。

### P2-3 没有 CI

`.github/workflows/` 不存在。本地等价物是 `npm run check`（typecheck + test + `--version`），完全依赖开发者自觉。

考虑到 README 明确说"Windows 11 是唯一已验证平台"，而 `local-workspace-provider.ts:211-212` 的 `copyTree` 用 `readFile` + `writeFile` 复制（**不保留 Unix 可执行位**，shebang 脚本复制后无法运行），Linux CI 的价值不只是防回归，而是直接暴露一类跨平台缺陷。

**改法**：加一个最小 workflow，`windows-latest` + `ubuntu-latest` 跑 `npm run check`。Linux 上大概率会红，那正是需要知道的信息。

### P2-4 仓库根目录堆积调试产物

12 个 `.typecheck*.txt` / `.errors*.txt`，外加 146KB 的 `.tmp-interfaces.txt`。它们都被 `.gitignore:42-44` 忽略了，所以不污染仓库，但污染工作目录，且内容全是历史 TS 错误快照（当前 typecheck 已经干净）。直接删除。

### P2-5 若干小的死代码

| 位置 | 问题 |
|---|---|
| `src/cli/main.ts:84-106` | `main()` 解析了 `--help`/`--version` 但无论如何都打印 help；与 `runCli` 前两个分支重复，只被 `baseline.test.ts` 使用 |
| `src/application/codex-experiment.ts:429-431` | `resolvedAgentConfig` 是恒等函数 |
| `src/cli/commands.ts:192` | `offlineComparison` 的 `_now` 参数未使用 |
| `src/infrastructure/store/experiment-store.ts:341-343` | `isArtifactManifest` 只检查 `owner.experimentId` 是否存在，任何含该路径的 JSON 都会被当成 manifest；应改用 TypeBox schema |
| `src/tui/local-history.ts:63` | 用 `readFile` 探测 `report.html` 是否存在，应该用 `access`/`stat` |

---

## 六、结构性收敛：一套装配，两个入口

第二节列的三条路径里，真正需要独立存在的只有两条，而三套装配一套都不该保留。这一节是**优先于第三节单点修补**的结构性改动——它让 P1-1 那类漂移在编译期就不可能发生，同时删掉一个平行编排器。

### 6.1 `reprise compare` 及其配套命令应当删除

它名义上是"fixture 入口"，实际上是**第二个编排器**。`src/cli/commands.ts:86-99` 自己开 store、`acquireWriter`、构造 `CandidateRun`、驱动到终态、取 record、做比较、写报告，把 `executeExperiment` 的职责重新实现了一遍。它还带着自己的一套影子常量：

- 独立的 `runPolicy()`：30 秒 / 1 turn / 1 次模型调用（`commands.ts:215-217`），与 `codex-tui-workflow.ts:32` 的生产策略毫无关系
- 独立的 `manifestFor`（`commands.ts:203-213`），与 `codex-experiment.ts:123-132` 构造的 manifest 平行演化
- 硬编码的离线比较桩（`commands.ts:192-197`）

改动主编排时这些都不会跟着动，也没有任何机制提醒。

**删除它不会动到确定性测试的地基。** `ScriptedRuntime` 这个 `RuntimePort` 实现的唯一消费者就是 `commands.ts:82`；测试用的是 `ScriptedRunner`（一个 `TargetRunner` 假实现），通过 `test/support/scripted-runtime.ts` 转出。`candidate-run.test.ts` 和 `codex-experiment.test.ts` 都是直接 `new ScriptedRunner(...)`，不经过 CLI。所以：删 `ScriptedRuntime` 类，留 `ScriptedRunner`。

`reprise smoke-record` 同样删除——验收记录的写入在 `scripts/codex-real-runner.mjs:43-46` 已经做了一遍，CLI 命令是同一件事的第二条路径，且只有 `test/cli.test.ts` 在用。

`reprise report --experiment`（从已落盘事件重新渲染 report.html）一并删除。TUI 的 `/history` 已经能给出报告路径，重新渲染的需求可以在真的出现时再加。

`reprise setup` / `reprise cases` 随 fixture 路径一起删除；`setup --fixture` 冻结 fixture TaskCase 的能力如仍被测试需要，改为 `test/support/` 下的 helper。

`main.ts` 退化为：直接进 TUI，保留 `--version` / `--help` / `--data-dir` / `--sessions-dir`。

### 6.2 smoke 脚本保留，但改造成同一装配的一个参数

协议回归无法靠交互式 TUI 完成——改完 `runtime-port.ts` 不可能每次手动点一遍 `/config → /intake → /run`。无人值守地验证一次真实 app-server 往返，这个需求是成立的，所以脚本入口保留。

但它现在**自己重新装配了一遍**：`scripts/codex-real-runner.mjs:19,32-33` 手工 new 出 `PiAgentHost`、`ControllerAgent`、`ComparisonAgent`。而 `createHarnessAgents` 早就把需要的缝留好了：

```ts
// src/application/harness-agents.ts:21
export function createHarnessAgents(config: HarnessModelConfig, caller: PiTextCaller = new PiModelCaller(config)): HarnessAgents
```

第二个参数就是可注入的 caller。**TUI 与 smoke 的唯一真实差异，是 Harness agent 的模型从哪来**：TUI 用外部 OpenAI 兼容端点（`PiModelCaller`），smoke 用本地已登录的 Codex（`CodexTextCaller`，无需 API key）。这是一个参数，不是一套装配。脚本绕开这个缝手搓，正是它能把 `allowObservational`、`currentSummary`、`trajectorySummary` 三个不存在的字段传进去而无人发现的原因（见 P1-1）。

### 6.3 目标形状

把 `codex-tui-workflow.ts` 里写死的候选与策略提升为唯一默认值，工厂本身与 TUI 解耦：

```ts
// src/application/experiment-workflow.ts —— 唯一装配点
export const EXPERIMENT_DEFAULTS = {
  candidate: { candidateId: 'codex-luna-high', productId: 'codex', requestedModel: 'gpt-5.6-luna' },
  policy: { wallClockMs: 30 * 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10 * 60_000, maxConsecutiveNoProgress: 1 },
} as const;

export function createExperimentWorkflow(input: {
  dataDir: string;
  runtime: RuntimePort;
  agents: HarnessAgents;
  now: () => string;
  candidate?: CandidateSpec;
  policy?: RunPolicy;
}): ExperimentWorkflow;
```

两个调用点：

```ts
// TUI
createExperimentWorkflow({ dataDir, runtime, now, agents: createHarnessAgents(config) });

// smoke 脚本
createExperimentWorkflow({ dataDir, runtime, now, agents: createHarnessAgents(smokeConfig, new CodexTextCaller()), policy: SMOKE_POLICY });
```

脚本改写为 `.ts` 并纳入 `tsconfig.json` 的 `include`，于是传错字段在编译期就会红。这是 P1-1 的**结构性**解法，比逐个删掉漂移字段更可靠。

### 6.4 收敛的收益

| 删除项 | 行数 |
|---|---|
| `src/cli/commands.ts` 全部 | 212 |
| `ScriptedRuntime` 类（`scripted-runtime.ts:72-95`，`ScriptedRunner` 保留） | ~25 |
| `main.ts` 中 5 个命令的选项定义、解析与分发 | ~80 |
| `test/cli.test.ts` | 84 |

合计约 400 行，同时消除：一个平行编排器、一套影子策略常量、一条重复的验收写入路径、一份不再被任何生产路径使用的离线比较桩。

对既有条目的影响：

- **P1-1（脚本漂移）**：由 6.2 + 6.3 结构性解决，不需要单独修
- **P1-2（`maxProviderRetries`）**：删除面从 6 处降到 4 处，`commands.ts:200` 随之消失
- **P2-5 中的 `main()` 冗余、`offlineComparison` 的 `_now`**：随 `commands.ts` 与 `main.ts` 瘦身一起消失
- **P2-2（测试入口）**：`cli.test.ts` 删除后，改用 `node --test` glob 的收益更明显，且不再需要为 CLI 维护端到端 fixture

`test/cli.test.ts` 删除后唯一失去的覆盖是 CLI 参数解析本身；`CandidateRun` + `ExperimentStore` + 报告渲染的覆盖在 `candidate-run.test.ts`、`store.test.ts`、`comparison-report.test.ts`、`codex-experiment.test.ts` 中已经完整存在，且更直接。

---

## 七、建议的执行顺序

**第一批（半天内，全部是小改动，但都直接影响真实运行）**

1. `candidate-run.ts` 的定时器加 `clearTimeout`（P0-1）
2. 删掉 `pi-model-caller.ts:2` 的 `import { Type } from 'typebox'`（P1-4）
3. `#loadSessions` 加 try/catch（P2-1）
4. `#runtimeDetail`：渲染出来或删掉 I/O（P2-1）
5. 清理根目录 `.typecheck*.txt` / `.errors*.txt` / `.tmp-interfaces.txt`（P2-4）

**第二批（协议层健壮性，需要写测试配合）**

6. app-server RPC 超时 + `waitForTurn` 超时统一到 `RunPolicy.turnTimeoutMs`（P0-3）
7. 子进程终止升级路径 + `close()` 超时兜底（P0-4）
8. `writer.lock` stale 检测与回收（P0-5）

**第三批（结构性收敛，见第六节）**

9. 删除 `commands.ts` 全部 fixture 命令与 `ScriptedRuntime` 类，`main.ts` 瘦身为直接进 TUI（6.1）
10. 抽出 `createExperimentWorkflow` 与 `EXPERIMENT_DEFAULTS` 作为唯一装配点（6.3）
11. smoke 脚本改写为 `.ts`，走 `createHarnessAgents(config, new CodexTextCaller())`，纳入 `tsconfig` include（6.2）

第 9–11 项做完后，P1-1 自动消失，P1-2 与 P2-5 的删除面缩小。

**第四批（契约与语义，需要设计决策）**

12. `CodexTextCaller` 的工具与会话延续——先加显式失败，再决定是否复用 thread（P0-2）
13. `maxProviderRetries`：删除或实现（P1-2）
14. 保真度五元组：删除或真正实现分级（P1-3）

**第五批（工程化）**

15. `node --test` glob 替代 `index.test.ts`，补 `agent-tools` 安全边界测试（P2-2）
16. GitHub Actions，Windows + Linux 双平台（P2-3）
17. `CodexIntakeTui` 的 generation guard，随后按页面拆分（P2-1）

---

## 八、建议明确"不做"的事

这个项目的克制是一项资产，以下几点值得继续守住：

- **不要把真实 smoke 扩展成通用 benchmark CLI**。README 第 64 行已经把这条写成了明确决策，`codex-real-runner.mjs:16` 的注释也在守它。P1-1 要修的是漂移，不是把脚本产品化。
- **不要给 Host 加"模型失败时用启发式兜底"的能力**。`AgentInvocation` 失败态不带 `T` 这个设计是整个证据链可信度的地基，fallback 已经被删过一次，不要让它回来。
- **不要在 app-server 层放开工具或权限批准**。`runtime-port.ts:156-160` 的无条件拒绝是隔离性的关键。P0-2 要解决的是 Harness 自己的 Controller 工具，与候选运行时的权限边界是两件事，不要混为一谈。
- **不要为了"多候选对比"提前泛化**。`ExperimentSpec.candidates` 是数组，但全流程只有单 run 路径。在单 run 的证据链讲清楚之前，扩成多候选只会放大现有问题。
