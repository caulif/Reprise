# Reprise 架构与开发优化意见

日期：2026-08-13
范围：当前工作区全部源码（`src/` 约 5,230 行、`test/` 约 1,410 行）、入口脚本、构建与测试配置。
方法：按分层通读源码，对照三条真实入口（TUI / fixture CLI / smoke 脚本）走完端到端路径。

本文只谈**架构结构**和**开发方式**。它不重复产品定位辩论（见 `FIRST-PRINCIPLES-REVIEW.md`：已收缩为「重放与检视」），也不做逐条缺陷清单（见 `OPTIMIZATION-REVIEW.md`）。读完应能回答两件事：

1. 现在的边界该怎么长，才不会在加第二个 Runtime / 加一条真实路径时散架。
2. 日常开发、测试、验证该怎么收口，才不会再出现「脚本传了 `src` 不认识的参数」这类漂移。

---

## 1. 项目本质与当前形态

Reprise 是一个 **local-first Harness**：把本地 Codex 历史会话冻成不可变 `TaskCase`，在隔离工作区里用候选 Runtime 重放，用 Controller 模拟后续用户协作，用 Comparison 基于落盘证据写检视报告。它不宣布胜者，不跑统计重复，不安装 Codex，不持久化密钥。

价值链可以压成一句话：

> **冻结过去 → 隔离重放 → 模拟协作 → 诚实投影**

代码已经按这条链长出来了，但**装配这条链的入口有三套**，这是后面几乎所有架构与开发问题的共同根源。

当前规模还很小（约 28 个 `src` 文件），所以建议的优化都是**收敛与删除**，不是加层。这个体量再引入插件框架、事件总线或 DI 容器，会比现状更差。

---

## 2. 当前架构地图

### 2.1 分层（名义上是端口/适配器）

```
src/cli          装配根：fixture CLI + TUI 启动
src/tui          工作台状态机与渲染（不跑实验）
src/application  实验编排、CandidateRun、Comparison 投影入口
src/agents       Controller / Comparison 的 prompt + schema + session
src/core         schema、RuntimePort、状态机、identity
src/products     Codex 私有协议、会话冻结、text-caller
src/environment  本地工作区隔离
src/infrastructure  Store、Pi Host、工具、scripted runtime、模型配置
src/report       从 Host facts 投影 HTML
```

依赖方向大体健康：`core` 不依赖产品；Codex JSON-RPC 锁在 `products/codex`；`ScriptedRuntime` 让 fixture 路径零 provider。这是整仓最值得保留的一条线。

### 2.2 端到端（以 TUI 为准）

```
/config   harness-model.json（provider / model / effort / env:KEY）
/intake   扫描本地 Codex rollout JSONL → 用户确认 → 冻结 TaskCase
/run      preflight（只读）→ 用户确认费用 → startCodexExperiment
            ├ LocalWorkspaceProvider 拷贝隔离基线（拒绝 symlink）
            ├ ExperimentStore 单写者 append-only 事件日志
            ├ CandidateRun：created → preparing → launching
            │                 → awaiting_target ⇄ awaiting_controller
            │                 → finalizing → finished
            ├ Controller 循环（wallClock / maxModelCalls / noProgress）
            ├ 释放工作区前固化 changedPaths
            └ Comparison 只读证据 → comparison.md → report.html
/history  只读浏览已冻结案例与实验
```

设计意图正确：**先落盘事实，再让模型解读事实**。`inspectRun` 是确定性投影，不含模型推断。`AgentInvocation` 失败时不带领域值 `T`。Comparison 声称完成但没写出 `comparison.md` 时降级为 `agent_failure`。这些约束在代码里是一致的。

### 2.3 三条入口，三套装配

| 入口 | 位置 | Target Runtime | Harness Agent | 用途 |
|---|---|---|---|---|
| `reprise tui` | `src/cli/main.ts` → `codex-tui-workflow.ts` | `CodexRuntimePort` | `PiModelCaller`（需 `harness-model.json`） | 生产主路径 |
| `reprise compare` | `src/cli/commands.ts` | `ScriptedRuntime` | 离线桩，直接 `settleController('satisfied')` | 确定性回归 |
| `scripts/codex-real-smoke.mjs` | `codex-real-runner.mjs` | `CodexRuntimePort` | `CodexTextCaller`（走 Codex app-server） | 协议 smoke |

三条路径各自拼 `startCodexExperiment`（或绕过它），默认 policy、agent budget、candidate 模型、effort **不共享**。脚本还从 `dist/` 导入，且传入当前 `CodexExperimentInput` 不认识的字段（`allowObservational`、`currentSummary`、`trajectorySummary`）。

这不是「多入口」本身有问题——fixture 与真实路径分离是对的。问题是**没有单一 composition 函数**，于是默认值和契约只能靠人脑对齐。

---

## 3. 已经做对、不要优化掉的部分

优化建议从这里开始，是为了避免「架构改进」把克制拆掉。

1. **事实与推断分离。** `PiAgentHost` 失败不伪造领域值；Comparison 必须真写出 `comparison.md`。保持这个不变量，比任何抽象都重要。
2. **不可变写入。** `writeImmutable` / `writeImmutableJson` 用 tmp + `wx` + rename；事件有 checksum 和 sequence；`operationId` 幂等。Store 没有做成完整 Event Sourcing 框架，尺寸合适。
3. **安全边界具体且窄。** app-server 发起的请求一律拒绝；工具不接受文件系统路径；密钥只存 `env:NAME`。不要为了「通用工具系统」打开这条缝。
4. **状态机只有 7 态、21 行转移表。** `CandidateRun` 通过 `CandidateRunJournal` 与 Store 解耦，是应用层最干净的模块。
5. **TypeScript 开关已经够严。** `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noUnusedLocals`、`verbatimModuleSyntax`。不要再叠 ESLint 规则去重复这些。
6. **依赖极少。** 运行时只有 Pi 三件套 + TypeBox。保持「能用 Node 标准库就不用库」。

---

## 4. 架构优化

按「不改会持续腐化」排序。每条都给**最小改法**，避免重写。

### 4.1 收敛三条装配为一个 factory（最高杠杆）

**现状。** TUI、CLI、smoke 各自硬编码：

- 候选模型：TUI 写死 `gpt-5.6-luna`（`codex-tui-workflow.ts:17`）；smoke 另写一份常量。
- `RunPolicy`：TUI 30 min / 4 turns / 3 calls / 10 min turn；CLI fixture 30 s / 1 turn / 1 s；smoke 120 s / 3 turns / 2 calls。
- Agent budget：`harness-agents.ts` 90 s / 1 repair；CLI 1 s / 0 repair；smoke runner 默认 12 min。
- Harness caller：TUI 用 `PiModelCaller`；smoke 用 `CodexTextCaller`，且后者**静默忽略 tools**。

**后果。** 改 `startCodexExperiment` 的入参，脚本不会类型报错（它 import 的是 `dist/`，且是无类型 `.mjs`）。今天已经发生：smoke 仍读 `usedFallback`、仍传 `allowObservational`，全部被静默丢弃。

**建议。** 抽一个 typed factory，三个入口只选 profile，不各自拼对象：

```ts
createCodexExperimentAssembly({
  profile: 'tui' | 'fixture' | 'protocol-smoke',
  dataDir, runtime, now,
  harnessCaller: 'pi' | 'codex-app-server', // 唯一允许分叉的点
})
```

policy、budget、candidate 默认值放在同一文件（例如 `src/application/experiment-defaults.ts`）。CLI `compare` 应委托 `startCodexExperiment` + `ScriptedRuntime`，而不是自己再写一遍 store / CandidateRun / report。fixture 路径可以注入 stub Controller，但**编排必须走同一条函数**，否则 Controller 循环、duplicate send、wall-clock 永远不被 fixture 覆盖。

这项做完，4.2、5.2、5.3 的大半漂移会消失。优先于任何单点修补。

### 4.2 澄清 `PiTextCaller` 的契约，停止 Liskov 破坏

**现状。** `PiAgentHost` 只认 `PiTextCaller`。两个实现语义完全不同：

| | `PiModelCaller` | `CodexTextCaller` |
|---|---|---|
| 会话 | 同一 Agent 实例跨 `append` 保留 transcript | 每次 `append` 新进程 + 新 ephemeral thread |
| 工具 | 映射并执行 `AgentToolDefinition` | 签名接收 `tools`，实现完全不用 |
| 密钥 | 读 `env:NAME` | 用本机已登录的 Codex |
| 用途 | TUI 生产路径 | smoke 脚本 |

Controller / Comparison 的工具（`read_observation`、`read_artifact`、`write_comparison_report`）在 smoke 路径上等于没注册。Comparison 仍可能靠 prompt 里的 JSON context 写出信封，但**证据调查能力在两条「真实」路径上不一致**。

**建议（二选一，不要维持现状）：**

- **A. 生产对齐：** smoke 也走 `PiModelCaller` + 环境变量。协议验证只测 `CodexRuntimePort`，Harness Agent 与 TUI 同源。这是更干净的产品边界。
- **B. 契约诚实：** 把接口拆成 `SessionCaller`（可工具、可记忆）和 `EphemeralTextCaller`（无工具、无记忆）。`CodexTextCaller` 在 `tools.length > 0` 时直接 throw，而不是静默吞掉。Host 按 caller 能力决定是否把工具放进 prompt。

更倾向 A。B 是承认分叉；A 是消灭分叉。当前项目只有一个产品、一种真实 Runtime，养两套 Harness caller 的成本高于收益。

### 4.3 把 Codex 事件名移出 application 层

**现状。** `inspectRun`（`codex-experiment.ts:271-275`）硬编码：

- `codex.item_completed`
- `codex.server_request_rejected`

TUI timeline 同样 switch 一串 `codex.*` 事件。`codex-experiment.ts` 文件名和 `productId === 'codex'` 断言说明应用层已经是 Codex 工作流，不是通用实验引擎。

**这不一定是错的。** 项目明确「当前只做 Codex」。过早抽 `ProductPlugin` 会重复 `products/index.ts` 里那个几乎没人用的 `productPacks` 注册表。

**建议。** 不要做插件系统。做一件更小的事：把 `inspectRun` 从 448 行的编排文件里挪到 `src/products/codex/observation.ts`（或 `application/observation.ts` + Codex 适配函数）。Controller 循环和 Comparison 共用同一个 builder。application 只消费：

```ts
{ finalMessage?, commands, rejectedApprovals, evidenceRefs, summaries }
```

这样第二个 Runtime 到来时，改的是 observation 适配器，而不是实验编排。`RuntimeCapabilities`（`core/runtime.ts:36-44`）现在是纯声明——`CandidateRun` 从不读取——一并删掉或等真有分支时再加，不要先留七个布尔位。

### 4.4 Schema 按真实产品收紧，而不是按未来产品放宽

**现状。** `ExperimentSpec.candidates` 是 `minItems: 1` 的数组；真实路径写死 `candidates: [input.candidate]`、`runs: [record]`。`taskCase` 可以是 `(baseline) => TaskCase`，只在 execute 使用，preflight / TUI 不支持。`EnvironmentClue` / `_policy` 仍挂在 `LocalWorkspaceProvider` 签名上，是 Recovery 删除后的断骨。

**建议。** 下次触及 schema 时一次性收：

- `candidates` 改为单个 `candidate`（或文档化为「v1 只取第一项」并在写入时 assert length === 1）。
- 删掉 `taskCase` 函数形态，或给它一个明确的 Recovery 替代者——现在没有 Recovery，函数形态是死灵活性。
- `inspectBaseline` / `resolveBaseline` 去掉未用的 `clues` / `policy` 参数。
- `StructuredAgentResult` 别名（`pi-agent-host.ts:16-17`）在应用层已混用，迁完后删掉，统一 `AgentInvocation`。

原则：**schema 只描述代码现在会持久化的形状。** 预留数组会让读者以为多候选已实现，测试也只会覆盖单元素。

### 4.5 拆 `CodexIntakeTui`，不要再往 747 行状态机里加页

`src/tui/codex-intake.ts` 是全仓最大文件（约 747 行），持有 40+ 私有字段、14 种 `Page`。渲染已经拆到 `workbench-render.ts`，这是对的。剩下的问题是**工作流编排、产品 I/O、键盘分发挤在一个类里**：

- 直接调用 `discoverCodexSessions` / `freezeCodexSession` / `readHarnessModelConfig` / `PiModelCaller.validate`
- `/run` 通过注入的 `CodexTuiWorkflow` 还算端口化
- `/intake` 和 `/config` 没有对等的端口

**建议。** 不需要完整 MVC。按页面把命令处理挪到三个函数模块即可：

- `tui/pages/config.ts`
- `tui/pages/intake.ts`
- `tui/pages/run.ts`（已有 workflow）

`CodexIntakeTui` 只保留：当前页、输入路由、`#render`、生命周期。键盘闭环 `/config → /intake → /run → /history` 已经很好，不要扩成通用 Agent TUI。

candidate / effort 应从 runtime 或 config 读取。`workbench-render.ts` 确认页写死 `high reasoning`，与 workflow 未暴露 effort 配置不一致——这是 UI 层的装配泄漏，会随 4.1 一起消失。

### 4.6 产品包注册表要么当真用，要么删成 re-export

`src/products/index.ts` 导出 `productPacks = [codexProductPack]`。生产入口（`main.ts`、`codex-tui-workflow.ts`）直接 `new CodexRuntimePort()`，从不查表。只有 `test/codex-pack.test.ts` 断言 `length === 1`。

`codexProductPack.runtime` 还在模块加载时 `new CodexRuntimePort()`，等于为了一个测试用的单例白做一次构造。

**建议。** 在第二个产品出现之前，把 `index.ts` 改成显式 re-export，测试断言 `codexProductPack.manifest.productId === 'codex'`。插件数组是「看起来可扩展、实际不可替换」的表面积。

### 4.7 Preflight 与 execute 必须用同一条 baseline 语义

`preflightCodexExperiment` 调用 `inspectBaseline`（只读指纹，不复制）；`executeExperiment` 调用 `resolveBaseline`（复制到 `baselines/{caseId}`）。两者 fingerprint 的对象不同（源树 vs 副本），而且 `resolveBaseline` 在标记文件已存在时会跳过复制——preflight 通过的树，execute 可能用到旧副本。

**建议。** preflight 继续只读（这是产品承诺：「不创建 Candidate 工作区、不调用 target」）。但 execute 应比较「源树当前 digest」与已有 baseline 标记；不一致则拒绝或要求用户确认覆盖。不要静默复用旧 `baselines/{caseId}`。

`inspect` vs `resolve` 的语义差异值得保留，但必须在 preflight 结果里写明：「本次只验证源树可读；运行时会再拷一份，若源树在确认后被改写则以运行时为准。」

### 4.8 观察层与 Controller 会话的生命周期

两处资源没有收口，属于架构而不是偶发 bug：

1. **`timeoutAfter`（`candidate-run.ts:303-305`）** 在 `Promise.race` 中从不 `clearTimeout`。turn 正常结束仍留下最多 `turnTimeoutMs`（TUI 下为 10 分钟）的定时器，拖住进程退出。应返回 `{ promise, cancel }`，race 结束后取消。
2. **`ControllerAgent.#sessions`** 只在 `cancel()` 时 delete。正常 `done` 路径不清理 Pi session。TUI 一次进程可跑多次实验，Map 会累积。`ExperimentHandle` 的 `finally` 应调用 `controller.cancel(runId)` 或新增 `complete(runId)`。
3. **`CodexAppServerClient.request`** 无客户端超时。app-server 丢帧时 pending Promise 永久挂起，上层只能靠 `turnTimeoutMs` 这条旁路。RPC 层应接受 `AbortSignal`。`CodexTextCaller` 的 `completion` 若收不到匹配的 `turn/completed`，同样永不 resolve。

Store 的 `writer.lock` 用 `wx` 独占，崩溃后不会回收——本地单人工具可接受，但 `close()` 失败时用户只能手动删文件。open 时对 lock 内 `pid` 做 `process.kill(pid, 0)` 探测，成本很低。

这些不是「加一个 ResourceScope 框架」的理由。给三个具体对象补 dispose 即可。

---

## 5. 开发优化

### 5.1 测试策略：现在测得到骨架，测不到协议

**现状做得好的地方：**

- 单一 `node:test`，无 Jest/Vitest。
- `handleInput` / `preview(width)` 让 TUI 可单测。
- Store、CandidateRun、experiment 编排、报告投影都有针对性测试。
- `codex-experiment.test.ts` 用 `VerifiedRuntime` 覆盖「Comparison 没写文件则失败」这条产品不变量。

**缺口（按风险）：**

| 层 | 文件 | 问题 |
|---|---|---|
| 协议 | `runtime-port.ts`（399 行） | **零测试。** JSON-RPC 分帧、server-request 拒绝、turn settlement 是整个真实路径的地基。 |
| 协议 | `text-caller.ts` | 无测试；tools 被忽略这一事实没有任何断言。 |
| 脚本 | `scripts/*.mjs` | 无类型、不进 `tsc`、不进 `npm test`。 |
| 装配 | CLI `compare` vs `startCodexExperiment` | fixture 路径跳过 Controller 循环，回归绿灯证明不了生产编排。 |
| 时间线 | `timeline.test.ts` | 已按 `payload.value` 形状测（好）；需保持「测试喂生产者形状，不喂消费者假设」。 |
| 索引 | `test/index.test.ts` | 手工 barrel。新增 `foo.test.ts` 若不登记，`npm test` 不会跑它。 |

**建议。**

1. 给 `CodexAppServerClient` 抽可注入的 stdio 传输（或对假进程测 `#handleLine`），覆盖：合法响应、server-initiated request 拒绝、坏 JSONL、exit 时 failAll。不需要真 Codex。
2. `CodexTextCaller.createSession` 加一个断言测试：非空 `tools` 必须失败（若选 4.2-B）或根本不在生产装配里出现（若选 4.2-A）。
3. 删掉 `test/index.test.ts` barrel，改用 `node --test dist/test/**/*.test.js`（排除 `support/`）。少一次「忘记登记」的人为错误。
4. 把 smoke 脚本改成 TypeScript（见 5.2）后，至少对 `acceptanceRecord` 的字段做 `Value.Check` 单测，避免再读已删除的 `usedFallback`。

不要追求覆盖率数字。协议客户端和装配 factory 是现在唯一会在真实跑中翻车、而 fixture 又看不见的两层。

### 5.2 停止从 `dist/` 跑无类型脚本

```js
import { startCodexExperiment } from '../dist/src/application/codex-experiment.js';
```

`scripts/codex-real-runner.mjs` 与 `codex-real-smoke.mjs` 有三层错位：

1. **类型在墙外。** `allowObservational` 等多余字段、`usedFallback` 等缺失字段，`tsc` 全看不见。
2. **必须先 build。** `src` 改了但忘了 `npm run build`，脚本跑的是旧行为。这比「慢」更危险。
3. **验收记录契约漂移。** smoke 仍把 `controllerFallback: run.decision.usedFallback` 写进 acceptance JSON；`AgentInvocation` 早已没有该字段。

**建议。** 二选一：

- 把 runner/smoke 改成 `scripts/*.ts`，由 `tsc` 编进 `dist/scripts/`，`package.json` 的 `smoke:codex` 指向编译结果；或
- 用 Node 的 `--experimental-strip-types`（22+ 已具备）直接跑 `src` 旁的 `.ts` 脚本。

不要引入 `tsx` 作为唯一能跑通 smoke 的运行时——项目目前零构建器依赖，这个优势值得留。无论哪种，**禁止再手写对 `dist/` 的 import。**

`copy-test-fixtures.mjs` 可以留：它是 postbuild 的机械复制，没有领域契约。

### 5.3 构建与本地闭环偏慢、偏脆

当前：

```
npm run check = typecheck + (build + node --test dist/test/index.test.js) + reprise --version
```

测试必须完整 `tsc` 一遍。`rootDir: "."` 把 `src` 和 `test` 编进同一 `dist/`，所以测试能 `import '../src/...'`——这是刻意的，可保留。但开发时改一行要等整个项目编译。

**建议（按侵入性）：**

1. **立刻可做：** `test` 脚本改为 `node --test dist/test/**/*.test.js`，去掉 barrel。
2. **值得做：** 增加 `test:watch` 没有必要上 vitest；`tsc --watch` + 另一个终端跑 test 即可。在 README「本地开发」里写两行。
3. **不要做：** 为了快引入 bundler 或把测试改成 ts-jest。体量 6k 行，`tsc` 秒级。真正的成本是「脚本不参与编译」和「barrel 漏测」，不是编译器速度。
4. **Windows 是已验证平台**，但 `CodexRuntimePort` 对 `.cmd` 走 `shell: true`。任何新的 spawn 都要在 Windows 上测 shim。如果以后加 CI，矩阵至少要有 `windows-latest`；只跑 ubuntu 会假绿。

仓库里没有 `.github/`、没有 ESLint、没有 Prettier。对这个规模是合理的。若加 CI，只跑 `npm run check` 就够。不要在没有多人格式战争之前加 Prettier。

### 5.4 默认值与「可重复开发路径」名不副实

README 承诺 fixture 路径不调用 provider，这是真的。但它**不是**生产路径的缩小版：

- 不跑 Controller 循环
- 不跑 Comparison 工具写 `comparison.md`（离线桩直接 `insufficient_evidence`）
- policy 与生产差一个数量级
- 不经过 `createCodexTuiWorkflow`

结果：`npm run check` 全绿，真实 TUI 仍可能在 RPC 超时、timeline 投影、tools 缺失上失败。这是开发流程问题，不是测试数量问题。

**建议的开发金字塔：**

```
fixture CLI（ScriptedRuntime + 同一 startCodexExperiment）
    → 每次改编排都跑；零网络

协议单元（假 stdio 的 CodexAppServerClient）
    → 每次改 runtime-port / text-caller 都跑；零 Codex 安装

显式 smoke（REPRISE_RUN_CODEX_SMOKE=1）
    → 协议变更或发版前；人工验收记录
```

今天缺的是中间那一层，以及 fixture 与生产共享编排。补这两块，比再写 20 个 TUI 按键测试更有用。

### 5.5 代码卫生：删断骨，而不是加注释

Recovery Agent 已删除，但痕迹还在：

- `LocalWorkspaceProvider` 的 `_clues` / `_policy`、注释里的「later recovery」
- `test/codex-intake.test.ts:285` 仍构造 `recovery: { value: { status: 'ready_for_provider_validation' }, usedFallback: false }`
- smoke 的 `usedFallback`
- `EnvironmentClue = JsonRecord`

这些不会让 `tsc` 失败（多余对象字段在测试里是普通 JSON），但会让下一个读代码的人以为 Recovery 还存在。

`identity.ts` 已经收敛了 `SAFE_ID` / `sha256` / `writeImmutable`，这是对的。`writeImmutableJson` 留在 store 里作为 JSON 封装也可以，不必再合并一次。

根目录的 `.typecheck*` / `.errors*` / `.tmp-interfaces.txt` 已被 gitignore；若仍在工作区磁盘上，直接删，避免和真实源码一起出现在编辑器里。

### 5.6 文档与对外契约

- `package.json` 的 `description` 仍是 *comparing agent runtimes*；README 已改为「重放与检视」。对外 npm/GitHub 摘要应与 README 第一句对齐。
- `/docs/` 整体 gitignore 是已确认的选择性开源策略。注意：本地规范若继续使用代码里不存在的名字（历史文档中的 `AgentProductPlugin`、`TaskCaseBuilder`），选择性开源时会把漂移一起放出去。以代码符号为准维护私有文档即可，不必现在入库。
- README 的 fixture 命令与 TUI 键盘闭环写得很清楚，是好的开发入口。缺的是一张「三套入口差异」表——建议把本文 §2.3 缩成 README 的一小节，避免贡献者只跑 `compare` 就以为覆盖了 TUI。

### 5.7 模块尺寸与「下一个文件该放哪」

当前几个偏大的文件：

| 文件 | 行数 | 建议 |
|---|---|---|
| `tui/codex-intake.ts` | 747 | 按页拆命令处理，见 4.5 |
| `application/codex-experiment.ts` | 417 | 抽出 `inspectRun` / `runControllerLoop` / `finishExperiment` 三个函数模块，文件变成真正的编排 |
| `products/codex/runtime-port.ts` | 399 | `CodexAppServerClient` 与 `CodexTargetRunner` 已经是两个类，可以分文件；先加协议测试再拆，避免只搬家 |
| `infrastructure/store/experiment-store.ts` | 330 | 尺寸可接受；锁 / checksum / artifact 内聚在一起更好查 |
| `application/candidate-run.ts` | 302 | 保持不动 |

经验规则：**新代码先问「是不是现有函数的分支」**。Controller 循环的预算检查、duplicate send、done 结算已经在 `runControllerLoop`；不要为每种 limit 再开一个 policy 对象。

---

## 6. 建议落地顺序

不要并行铺开。每一项都应该能单独合并，且 `npm run check` 仍然只依赖 fixture。

### 第一刀（结构，约 1–2 天）

1. **`createCodexExperimentAssembly` + `experiment-defaults.ts`。** TUI / CLI / smoke 改成选 profile。CLI `compare` 走 `startCodexExperiment`。
2. **脚本改 TypeScript（或 strip-types）并纳入 `tsc`。** 删掉 `usedFallback`、`allowObservational`、死参数。acceptance 用现有 `AgentInvocation.status`。
3. **`timeoutAfter` 取消定时器；RPC `request` 加 AbortSignal；Controller session 在 experiment finally 里释放。**

做完这三件，装配漂移和真实长跑挂起是当前最大的两类风险，会被同时按住。

### 第二刀（可测的协议，约 1 天）

4. `CodexAppServerClient` 可测传输 + 拒绝 server-initiated request 的测试。
5. 明确 `PiTextCaller`：smoke 改 `PiModelCaller`，或 `CodexTextCaller` 拒绝 tools。
6. `node --test dist/test/**/*.test.js`，删除手工 barrel。

### 第三刀（收口，有空再做）

7. `inspectRun` 下沉到 Codex observation；application 不再出现 `codex.item_*`。
8. 按页拆 TUI 命令处理。
9. schema 收紧单候选；删 `EnvironmentClue`、函数型 `taskCase`、`StructuredAgentResult` 别名、`productPacks` 数组。
10. `package.json` description 对齐 README；README 补三入口差异表。
11. baseline digest 在 execute 时与源树比对。
12. writer.lock 的 stale pid 探测。

### 明确不要做的

- 不要为「将来多个产品」做插件框架、能力注册表、或通用 Agent TUI。
- 不要把 Store 升级成带快照/投影的 Event Sourcing。
- 不要引入 DI 容器、monorepo、eslint-plugin 全家桶。
- 不要把 Comparison 变回排名引擎；产品已经选择方案 B。
- 不要为了本地速度引入第二套测试运行时。

---

## 7. 总判断

Reprise 的骨架是端口/适配器 + 不可变事实日志 + 窄安全边界，这个组合配它的产品定位（单人、local-first、只做 Codex、不宣布胜者）是匹配的。主要风险不在「缺少抽象」，而在：

1. **同一条实验链被装配了三次**，类型系统和测试都只覆盖其中一条。
2. **`PiTextCaller` 被两个语义相反的实现共用**，真实 smoke 与真实 TUI 对工具的承诺不同。
3. **最靠近外部进程的代码（app-server RPC）没有自动化测试**，也没有 RPC 级超时。
4. **无类型 `dist/` 脚本**让契约删除后仍能「跑通」并写出无意义的验收字段。

下一步的架构工作是收敛，不是扩展。把三条入口收成一个 typed factory、让 fixture 走同一条 `startCodexExperiment`、让协议客户端可测——这三件事做完，这个体量的项目在架构和开发上就够用了。
