# Reprise 架构导读：对照实验的办公室是怎样搭起来的

状态：研究导读，非规范  
日期：2026-09-07  
浏览器阅读（SVG 可渲染）：[reprise-architecture-walkthrough.html](./reprise-architecture-walkthrough.html)  
规范仍以[产品定义](../product/overview.md)和[架构总览](../architecture/overview.md)为准。本文解释设计如何落到代码，并标出后续优化要面对的结构张力；不重新定义公共类型。

---

你在 Codex 或 Claude Code 里用某个模型，好不容易做完一件真实任务。现在你想换一个模型再试一次，真正想知道的不是榜单分数，而是：

> 在我已经完成过的这件事上，换成另一个模型，结果、效率和成本会不会更好？

这个问题看起来像“再跑一遍 Agent”。真正动手时，麻烦立刻出现：

- 原任务发生在哪个目录、哪些文件、哪个 Git 状态？候选开始前环境对不对？
- 原用户后来补充过约束、纠正过方向。候选走了另一条路，还要不要把原话原样贴回去？
- Codex 的 JSON-RPC 和 Claude Code 的会话文件完全不是同一种私有协议，谁负责翻译？
- 模型说“写完了”，和 Runtime 真正接纳输入、一轮真正结束、Harness 决定停机，是不是一回事？
- 进程中途崩溃，下次怎么知道已经发生了什么，而不是凭记忆猜？

这些问题很少由被测模型自己解决。Reprise 做的，就是把它们收进一套本地对照实验系统。

Reprise 评测的不是裸模型，而是**某个模型坐进 Codex / Claude Code 这间办公室之后的个人效用**。它自己也是一间办公室——不过这间办公室里坐的不是写代码的员工，而是实验员、环境恢复员、扮演原用户的协作者，以及事后整理证据的研究员。

```text
被测对象：候选模型 + 目标 Agent 产品 Runtime
实验装置：Reprise Harness（编排、隔离、事实、三个内部 Agent、TUI）
唯一有意改变的变量：候选模型
其余条件尽量固定，无法固定的写成 mismatch / unknown / warning
```

---

## 一、先把公式讲透：模型不会直接使用你的电脑

聊天界面容易制造错觉：你说一句话，Agent 就“改了文件”“跑了命令”。模型没有直接碰到硬盘或终端。它输出的是结构化意图；外面的程序检查工具是否存在、参数是否合法、权限是否允许，再调用真实系统，把结果送回下一次模型请求。

Reprise 研究的就是这件事：**两间配置尽量相同的办公室，只换脑子，对你做过的那件真实工作，结果差在哪里。**

因此 Reprise 有两条绝不能混的线：

| 线 | 谁在跑 | 职责 |
|---|---|---|
| 目标平面 | Codex / Claude Code 进程里的候选模型 | 完成原任务 |
| 实验平面 | Reprise 的确定性编排 + Recovery / Controller / Comparison | 恢复环境、扮演用户、记录事实、组织对照 |

Controller 不是第二个写代码的 Agent。它模拟的是**同一个有能力的人面对不同轨迹时会输入什么**。Recovery 不是建议生成器，它要在隔离 staging 里真的恢复文件。Comparison 不打分，只选择值得并排查看的证据。

术语解释：**Harness**  
这里的 Harness 不是测试框架里随便包一层的 runner。它拥有实验状态机、隔离环境、事件日志和用户控制面。目标产品自己的 Harness（Codex 的 app-server、Claude Code 的会话运行时）对 Reprise 来说是外部 Runtime，必须通过端口适配，不能直接当内部模块用。

---

## 二、整体结构：配置入口、编排内核、五块能力、一条运行环

Reprise 明确不做插件市场、热加载或 DI 容器。它用静态注册的 Product Pack 和显式函数装配，换来可审计的单进程单体。

整体可以看成四层：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 620" width="880" height="620" role="img" aria-label="Reprise 整体结构">
  <rect width="880" height="620" fill="#FBF8F3"/>
  <text x="40" y="42" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="26" font-weight="700" fill="#1C2430">Reprise 整体结构</text>

  <!-- 控制面 -->
  <text x="40" y="88" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#3B7DC4">控制面</text>
  <rect x="36" y="78" width="4" height="16" rx="1" fill="#3B7DC4"/>
  <rect x="40" y="100" width="800" height="86" rx="16" fill="none" stroke="#9BB8D9" stroke-width="1.5" stroke-dasharray="6 5"/>
  <g>
    <rect x="62" y="116" width="230" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
    <text x="177" y="138" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">TUI / CLI</text>
    <text x="177" y="156" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">用户入口</text>
  </g>
  <g>
    <rect x="325" y="116" width="230" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
    <text x="440" y="138" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">.reprise/harness-model.json</text>
    <text x="440" y="156" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">内部模型配置</text>
  </g>
  <g>
    <rect x="588" y="116" width="230" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
    <text x="703" y="138" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">ExperimentSpec</text>
    <text x="703" y="156" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">实验配方</text>
  </g>

  <path d="M440 186 L440 214" stroke="#3B7DC4" stroke-width="1.8" fill="none" marker-end="url(#arrow)"/>

  <!-- 编排 -->
  <rect x="170" y="220" width="540" height="58" rx="14" fill="#E3EFFB" stroke="#3B7DC4" stroke-width="1.8"/>
  <text x="440" y="244" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">确定性应用流程 · 不持有产品私有协议</text>
  <text x="440" y="264" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="16" font-weight="700" fill="#1E3A5F">Experiment Application</text>

  <path d="M250 278 L180 314" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>
  <path d="M440 278 L440 314" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>
  <path d="M630 278 L700 314" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>

  <!-- 三阶段 -->
  <g>
    <rect x="48" y="318" width="196" height="70" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
    <text x="146" y="346" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">Case Preparation</text>
    <text x="146" y="368" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">冻结 TaskCase</text>
  </g>
  <g>
    <rect x="342" y="318" width="196" height="70" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
    <text x="440" y="346" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">Candidate Run</text>
    <text x="440" y="368" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">隔离执行 + 协作</text>
  </g>
  <g>
    <rect x="636" y="318" width="196" height="70" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
    <text x="734" y="346" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">Comparison</text>
    <text x="734" y="368" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">只读对照投影</text>
  </g>

  <path d="M146 388 L146 418" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>
  <path d="M440 388 L440 418" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>
  <path d="M734 388 L734 418" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>
  <path d="M146 418 L734 418" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>
  <path d="M440 418 L440 438" stroke="#3B7DC4" stroke-width="1.5" fill="none"/>

  <!-- 能力面 -->
  <g>
    <rect x="40" y="444" width="148" height="72" rx="12" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.5"/>
    <text x="114" y="474" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Product Pack</text>
    <text x="114" y="494" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">会话 / Runtime</text>
  </g>
  <g>
    <rect x="202" y="444" width="148" height="72" rx="12" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.5"/>
    <text x="276" y="474" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Environment</text>
    <text x="276" y="494" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">基线 / 隔离副本</text>
  </g>
  <g>
    <rect x="364" y="444" width="148" height="72" rx="12" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.5"/>
    <text x="438" y="474" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Pi Agent Host</text>
    <text x="438" y="494" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">内部 Agent 循环</text>
  </g>
  <g>
    <rect x="526" y="444" width="148" height="72" rx="12" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.5"/>
    <text x="600" y="474" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Trace Store</text>
    <text x="600" y="494" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">事件 / artifact</text>
  </g>
  <g>
    <rect x="688" y="444" width="148" height="72" rx="12" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.5"/>
    <text x="762" y="474" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Target Runtime</text>
    <text x="762" y="494" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">被测产品进程</text>
  </g>

  <path d="M114 516 L114 536 L762 536 L762 516" stroke="#3B7DC4" stroke-width="1.4" fill="none"/>
  <path d="M438 536 L438 552" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>

  <rect x="170" y="554" width="540" height="48" rx="14" fill="#E3EFFB" stroke="#3B7DC4" stroke-width="1.8"/>
  <text x="440" y="584" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="16" font-weight="700" fill="#1E3A5F">CandidateRun 状态机  ·  实验真正的运行环</text>

  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#3B7DC4"/>
    </marker>
  </defs>
</svg>
```

这四层在代码里大致对应：

| 层 | 落点 | 作用 |
|---|---|---|
| 配方 | `ExperimentSpec` + Product Pack 静态注册 + 本地模型配置 | 决定比较什么、用哪个内部模型；换产品靠改 Pack |
| 编排 | `src/application/` 的显式函数 | 依赖由 TypeScript 导入表达，卸载即进程退出 |
| 内部 Agent 设施 | Pi Agent Host + 角色工具面 | 只服务 Recovery / Controller / Comparison，不服务被测模型 |
| 运行环 | `CandidateRun` 七状态机 | 一拍是 Target turn + Controller 决策，不是单次模型请求 |
| 事实 | `events.jsonl` | 进入模型的输入必须能从日志复原 |

术语解释：**Product Pack**  
某一种 Agent 产品的静态适配包。它把该产品的会话发现、Runtime 启动、原生事件翻译和 Recovery Playbook 打成一份不可拆的包。公共代码接口名是 `AgentProductPlugin`，文档叙述统一叫 Product Pack。当前静态注册 Codex 与 Claude Code，见 `src/products/index.ts`。

---

## 三、三段生命周期：先冻结考卷，再跑候选，最后才投影对照

一次完整使用路径写在[产品定义](../product/overview.md#2-用户工作流)。架构把它收成三段，对应三个服务边界：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 300" width="880" height="300" role="img" aria-label="三段生命周期">
  <rect width="880" height="300" fill="#FBF8F3"/>
  <text x="40" y="40" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="22" font-weight="700" fill="#1C2430">三段生命周期</text>

  <rect x="40" y="70" width="240" height="180" rx="16" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="160" y="104" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#3B7DC4" font-weight="700">1  Case Preparation</text>
  <text x="160" y="132" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">发现会话</text>
  <text x="160" y="156" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">导入并冻结 TaskCase</text>
  <text x="160" y="180" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">Recovery 恢复环境</text>
  <text x="160" y="204" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">Provider 验证基线</text>
  <text x="160" y="228" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">产物：不可变考卷</text>

  <path d="M292 160 L328 160" stroke="#3B7DC4" stroke-width="2" fill="none"/>
  <polygon points="328,154 340,160 328,166" fill="#3B7DC4"/>

  <rect x="348" y="70" width="240" height="180" rx="16" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="468" y="104" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#3B7DC4" font-weight="700">2  Candidate Run</text>
  <text x="468" y="132" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">解析当前 Runtime</text>
  <text x="468" y="156" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">准备隔离副本</text>
  <text x="468" y="180" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">Target 执行 turn</text>
  <text x="468" y="204" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">Controller 发送或结束</text>
  <text x="468" y="228" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">产物：RunRecord + trace</text>

  <path d="M600 160 L636 160" stroke="#3B7DC4" stroke-width="2" fill="none"/>
  <polygon points="636,154 648,160 636,166" fill="#3B7DC4"/>

  <rect x="656" y="70" width="184" height="180" rx="16" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="748" y="104" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#3B7DC4" font-weight="700">3  Comparison</text>
  <text x="748" y="140" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">显式启动</text>
  <text x="748" y="164" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">Planner / Reporter</text>
  <text x="748" y="188" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">写出 report.html</text>
  <text x="748" y="228" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">不改运行结果</text>
</svg>
```

三件事把这条链钉死：

1. **原始完成结果不重跑。** 历史会话是基线事实，不经过 TargetRunner 回放。产品只比较“每个候选 vs 那次原始完成”，不在候选之间排名。
2. **TaskCase 冻结后只读。** 改会话、证据、环境或隐私策略就建新 Case。正常候选运行不再去翻产品私有 JSONL。
3. **Comparison 不属于运行状态机。** 对照失败不能把一次已经 `finished` 的候选改写成失败；默认还可以跳过对照。

实现入口：

- 会话导入与冻结：`src/products/*/sessions.ts` → `src/products/shared/freeze.ts`
- 恢复：`src/application/experiment-recovery*.ts` + `src/agents/recovery-agent.ts`
- 候选运行：`src/application/experiment.ts` 的 `startCodexExperiment` → `src/application/candidate-run.ts`
- 对照：`src/application/experiment-report.ts` + `src/agents/comparison-agent.ts`
- TUI 把上面串起来：`src/application/tui-workflow.ts` ← `src/tui/`

函数名仍带 `Codex`，是历史切片留下的。Claude Code 已经走同一条 Application 路径；这是后文要标出的命名张力，不是第二套实验内核。

---

## 四、核心对象：考卷、尝试、清单、记录

公共类型的唯一规范在[架构总览 · 领域模型](../architecture/overview.md#4-核心领域模型)。这里只讲它们在实验里各自守住哪条边界。

**TaskCase** 是冻结的历史任务输入。它不是“对 Codex 目录的动态查询”。里面同时放了两样容易被混用的东西：

- `initialInput`：第一条可执行用户任务句（跳过产品注入的 `AGENTS.md` 指令块）。它是考卷封面，**不是** Host 要原样投递给候选的第一句话。
- `transcript`：完整历史会话。Controller 用它理解这个人怎么协作、怎么验收，而不是按顺序把用户句贴回去。

**RunAttempt** 是 CandidateRun 的最小身份。Runtime 还没解析成功、环境还没准备好，这个身份也必须先落盘。准备失败仍然要有终态记录，所以不能用“一大坨可选字段的半 Manifest”表达非法中间态。

**RunManifest** 是启动条件齐备后才提交的冻结快照：实际模型身份、当前 Runtime、隔离环境、Controller 配置。提交后不可变。

**RunRecord** 是结束后的投影：到达过哪一阶段、任务看起来是否完成、因何停止、清理是否干净、fidelity、trace 切片和 warning。

术语解释：**fidelity 不是成败**  
`strict` / `exploratory` / `observational` 只描述证据强度。环境 mismatch、外部世界不受控、模型身份只能推断，都会降低对照可解释性，但不等于候选没做完任务。历史 Runtime 版本和当前版本不同，也不参与 fidelity；候选之间当前 Runtime 意外变化才记 `runtime_drift` warning。

结果本身被拆成三个正交面，见[运行结果协议](../architecture/run-outcome.md)：

- `TaskAssessment`：任务看起来完成了没有（可由 Controller 的 `done/satisfied` 给出 `apparently_completed`）
- `RunTermination`：这次运行因何停下（完成、预算、卡住、取消、失败、不确定）
- `CleanupResult`：隔离资源和 Runtime 进程有没有收干净

把“看起来做完了”和“因为超时停了”写成同一个枚举，报告就无法诚实。

---

## 五、Product Pack：私有协议停在适配器边界

Reprise 不在应用层判断“这是 Codex 还是 Claude Code”。新增 Runtime 能力的顺序是：先改 `src/core/runtime.ts` 端口，再改两个 Pack。这条规则写在仓库 `AGENTS.md`，对应[产品插件兼容性](../architecture/product-plugin-compatibility.md)。

每个 Pack 逻辑上长这样：

```text
products/<product-id>/
├── manifest          产品身份与版本
├── sessions          发现 / inspect / import
├── runtime           RuntimePort + TargetRunner
├── recovery/SKILL.md Recovery Playbook
└── fixtures          契约测试夹具
```

两道翻译墙：

```text
历史私有数据  → SessionSourceAdapter → ImportedSession
运行中私有事件 → RuntimePort          → TargetEvent / TurnSettlement
```

过了这道墙，Controller 和 Comparison **禁止**再去读 Claude 的 `.jsonl` 或 Codex 的 app-server 通知。它们只消费规范化会话、Target 事件、artifact 和 fidelity。

当前实现要点：

- 注册表：`src/products/index.ts` 的 `productPacks` 数组。没有目录扫描，没有动态 `import()`。
- 契约：`src/products/contract.ts`。
- Codex Runtime：`src/products/codex/runtime-port.ts`。通过 JSON-RPC 驱动 app-server；Windows 上默认沙箱是 `danger-full-access`，因为 `workspace-write` 无法打 deny-read ACL，隔离靠冻结副本而不是 OS sandbox。
- Claude Code Runtime：`src/products/claude-code/runtime-port.ts`。
- 进程启动：`src/products/shared/process.ts` 的 `spawnRuntimeProcess`。Windows `.cmd` shim 走 `ComSpec /d /s /c`，禁止 `shell: true`。
- 冻结：`publishFrozenCase` 先写 staging，再原子改名，带 `case.complete` 标记。

术语解释：**accepted ≠ started ≠ settled**  
这是 Runtime 适配里最贵的三个词。

- `accepted`：目标产品已经接纳这条用户输入（有 native admission、RPC 响应或持久化证据）。
- `started`：对应 turn 开始执行。
- `settled`：到达稳定输入边界或终止边界，Orchestrator 这时才可以问 Controller。

`unknown` 禁止自动重发。查不到旧 message/turn 就结束，记 `uncertain.input_delivery`。普通模型文本流不是 turn 边界；quiet-period 只是最后的 heuristic。

---

## 六、一次候选怎样跑：状态机才是 Reprise 的 Agent Loop

Reprise 的外环不是“一次模型请求”，而是 CandidateRun 的七个状态。合法转移集中在 `src/core/state-machine.ts`，任何状态变化必须 `assertTransition`。

```text
created → preparing → launching → awaiting_target
                                         ↓
                                   awaiting_controller
                                         ↓
                              send accepted → awaiting_target
                              done / 失败 / 预算 → finalizing → finished
```

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 430" width="880" height="430" role="img" aria-label="一次候选运行">
  <rect width="880" height="430" fill="#FBF8F3"/>
  <text x="40" y="38" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="22" font-weight="700" fill="#1C2430">一次候选运行</text>
  <text x="40" y="62" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">accepted 才能进入 awaiting_target；settlement 才能问 Controller；决策先落盘再发送</text>

  <rect x="40" y="86" width="150" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="115" y="108" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">1</text>
  <text x="115" y="126" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">RunAttempt</text>

  <rect x="210" y="86" width="150" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="285" y="108" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">2</text>
  <text x="285" y="126" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">隔离 prepareRun</text>

  <rect x="380" y="86" width="150" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="455" y="108" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">3</text>
  <text x="455" y="126" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">RunManifest</text>

  <rect x="550" y="86" width="150" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="625" y="108" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">4</text>
  <text x="625" y="126" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Controller 开场</text>

  <rect x="720" y="86" width="120" height="54" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="780" y="108" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">5</text>
  <text x="780" y="126" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">start / send</text>

  <path d="M190 113 L210 113" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>
  <path d="M360 113 L380 113" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>
  <path d="M530 113 L550 113" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>
  <path d="M700 113 L720 113" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>

  <rect x="40" y="176" width="800" height="150" rx="16" fill="none" stroke="#9BB8D9" stroke-width="1.5" stroke-dasharray="6 5"/>
  <text x="56" y="202" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" font-weight="700" fill="#3B7DC4">运行环（可多圈）</text>

  <rect x="64" y="220" width="200" height="78" rx="12" fill="#E3EFFB" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="164" y="250" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">Target Runtime</text>
  <text x="164" y="272" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">waitForTurn → settled</text>

  <rect x="340" y="220" width="200" height="78" rx="12" fill="#E3EFFB" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="440" y="250" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">Controller Agent</text>
  <text x="440" y="272" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">send 或 done</text>

  <rect x="616" y="220" width="200" height="78" rx="12" fill="#E3EFFB" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="716" y="250" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">Trace Store</text>
  <text x="716" y="272" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">先记事实再动作</text>

  <path d="M264 259 L340 259" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>
  <path d="M540 259 L616 259" stroke="#3B7DC4" stroke-width="1.6" fill="none"/>
  <path d="M716 298 L716 344 L164 344 L164 298" stroke="#3B7DC4" stroke-width="1.4" fill="none" stroke-dasharray="5 4"/>
  <text x="440" y="338" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="11" fill="#5A6A7A">send 被 accepted 后回到 Target</text>

  <rect x="40" y="360" width="250" height="50" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="165" y="390" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">finalizing：stop / fingerprint / release</text>
  <rect x="330" y="360" width="180" height="50" rx="12" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="420" y="390" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">finished + RunRecord</text>
  <rect x="550" y="360" width="290" height="50" rx="12" fill="#F7FBFF" stroke="#9BB8D9" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="695" y="390" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" fill="#1E3A5F">可选 Comparison，失败不改 outcome</text>
</svg>
```

`CandidateRun` 类把这条环写成可测试的状态推进，而不是散落的 if/else：

- `start` / `submit`：投递用户消息，观察 delivery，再 `waitForTurn`
- `settleController`：只接受 `satisfied | blocked | requires_real_user_decision | no_further_value`
- `failController` / `failBeforeStart`：模型侧失败不能冒充 `done`
- `stopByHarness`：预算、无进展、完成证据守卫——这些是 Harness 停机，不是 Controller 满意
- `#finishOnce`：永远经过 `finalizing`，先停 Runtime，再采集 artifact，再 `release`，再写 `RunRecord`

编排层 `startCodexExperiment` 在环外再做几件 Host 才该做的事：写 Controller briefing（INDEX、路径指针、settled turn 摘要）、调用 `understand` 预读历史协作、把 Controller 工具挂到隔离副本、连续无进展计数、把内部 Agent 审计事件写入同一条 experiment 日志。

不变量（完整列表见[架构总览 §10](../architecture/overview.md#10-candidaterun-七状态模型)）里对优化最关键的三条：

1. 只有 `awaiting_controller` 可以问 Controller。
2. 决策必须先持久化，再 `send` 或收尾。
3. `finished` 后迟到的原生事件可以追加，但不能改 `RunOutcome`。

---

## 七、三个内部 Agent：同一套 Host，三份完全不同的办公室

三个模块共享 `PiAgentHost` 的 session、工具循环和遥测，但**禁止共享对话状态**。装配发生在 `src/application/harness-agents.ts`：一个 Host 实例，三个 Agent 对象，独立 timeout 与 repair 预算。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 340" width="880" height="340" role="img" aria-label="四个智能角色">
  <rect width="880" height="340" fill="#FBF8F3"/>
  <text x="40" y="38" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="22" font-weight="700" fill="#1C2430">系统里其实有四个模型角色</text>

  <rect x="40" y="64" width="800" height="36" rx="8" fill="#E3EFFB"/>
  <text x="440" y="88" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#1E3A5F">Pi Agent Host：session、工具、压缩、schema 修复、审计。不发明领域结论。</text>

  <rect x="40" y="122" width="250" height="150" rx="14" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="165" y="150" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#3B7DC4" font-weight="700">Recovery</text>
  <text x="165" y="178" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">恢复开始前环境</text>
  <text x="165" y="202" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">写：仅 staging</text>
  <text x="165" y="222" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">出：recovery.md + 薄信封</text>
  <text x="165" y="248" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">八工具 + read_observation</text>

  <rect x="315" y="122" width="250" height="150" rx="14" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="440" y="150" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#3B7DC4" font-weight="700">Controller</text>
  <text x="440" y="178" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">扮演原用户协作</text>
  <text x="440" y="202" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">写：不写用户源目录</text>
  <text x="440" y="222" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">出：send | done</text>
  <text x="440" y="248" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">七件工作区工具</text>

  <rect x="590" y="122" width="250" height="150" rx="14" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="715" y="150" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#3B7DC4" font-weight="700">Comparison</text>
  <text x="715" y="178" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">组织并排证据</text>
  <text x="715" y="202" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">写：仅报告沙箱</text>
  <text x="715" y="222" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">出：report.html + 薄信封</text>
  <text x="715" y="248" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">Planner 与 Reporter 分 session</text>

  <rect x="40" y="288" width="800" height="36" rx="10" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.5"/>
  <text x="440" y="312" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" font-weight="700" fill="#1E3A5F">Candidate / Target：被测产品里的模型。Reprise 只启动它、投递输入、等待 settlement。</text>
</svg>
```

角色对齐的完整约束见[三个 Agent 的职责](../architecture/agent-roles-and-system-prompts.md)。下面只讲实现上真正咬合的几处。

### Recovery

它在 CandidateRun 之前工作。Host 先给出有界调查包（不是把整段历史塞进第一轮 prompt），再让 Agent 在 staging 里用工作区工具恢复。Provider 验证 preview 后自动 `acceptRecovery`；确认页问的是要不要开计费候选，不是再审一遍文件树。

失败分级很细：没有 accept 点的 fallback / 崩溃是“无法恢复”，禁止启动隔离候选；`partial` 允许额外工作区变更，但校验通过的 preview 必须暴露给后续流程。后一次完成信封不得覆盖已经探测通过的信封。

实现散落在 `experiment-recovery-*.ts` 一簇文件里。这是有意拆分长编排，也是阅读成本的来源。

### Controller

这是 Reprise 相对普通 runner 的产品差异点。设计专题是[Controller](../architecture/controller.md)。

固定的是能力条件：原用户表达过的目标与约束、原会话里的验收习惯、同一 Experiment 的 Controller 模型与工具、安全边界。不固定的是后续文本、轮次、以及因候选轨迹不同而产生的纠正。

开场也由 Controller 写第一句用户消息。Host 若把 `TaskCase.initialInput` 原文直接 `start`，就把“动态协作”退回成 replay。`failBeforeStart` 就是为这个缺口准备的：理解阶段失败时，不得偷偷投递冻结封面。

Controller 看的磁盘布局是路径 briefing：INDEX 进 append，briefing 目录不进候选副本，工作区工具打在隔离副本上。历史会话不得被复制进候选工作区，否则被测模型会看见“未来的答案”。

停机看的是这个人面对当前轨迹还会不会说话，不是把历史用户句按序用完，也不是匹配终态句种类。Harness 另外有完成证据守卫：Controller 声称满意时，Host 可以因证据不足停机，记 `stalled.controller_completion_guard`，不能改写成 `done/satisfied`。

### Comparison

默认跳过。TUI 对照门或 CLI `--compare` 才启动。Planner 写 `work/comparison-plan.md`，Reporter 可以否定计划并直接写 `report.html`。Host 只校验薄信封、证据归属和文件可读，不重排 HTML。`candidate/` 是 run 结束后仍保留的隔离副本的只读挂载。详见[Comparison 设计](../architecture/comparison.md)。

---

## 八、Pi Agent Host：内部 Agent 的真实循环

早期偏差是：所谓 Host 只是 `JSON.stringify(context)` + `completeSimple` + schema 修复。三个 Agent 都被压成一次性分类器。当前边界在 `src/infrastructure/pi-agent-host.ts`：

Host 拥有：session 身份、超时与取消、注册工具、结构化输出校验与有界 repair、compaction 回调、审计事件。  
Host **不拥有**：领域状态、跨角色共享对话、模型失败时的 fallback 领域值。

`AgentInvocation<T>` 是刻意的类型：失败分支没有 `T`。这样 TypeScript 会阻止把 Host 事实写成 Controller 决策。

内部循环复用 `@earendil-works/pi-agent-core` / `pi-ai`，但不套用 `pi-coding-agent` 应用壳。技术选型见[实现基线](../architecture/technology-selection.md)。模型调用器是 `PiModelCaller`；凭据走 Pi `auth.json` 或 Git 忽略的 `.reprise/harness-model.json`，不读 Codex CLI 登录态，也不把密钥写入事件。

上下文过长时，压缩后的试卷必须能从事件复原：`agent.context_compacted` 记录 summary 与 retained tail。这是“进入模型的输入必须可追溯”在内部 Agent 上的落点。

工具面：

- Recovery / Comparison：工作区七件套 + `read_observation`
- Controller：七件工作区工具，不注册 `read_observation`；观察改走 briefing 与按需读文件
- `read_observation` 只翻 Host 事实页，调用方不能传文件系统路径

术语解释：**薄信封**  
Agent 可以写很长的 `recovery.md` 或自由结构 `report.html`。机器只认一小段 schema：状态、固定路径、证据引用、少量稳定字段。Host 验证信封，不解析散文。叙事和事实分开，模型失败就不能污染 `RunOutcome`。

---

## 九、环境恢复：隔离副本是安全边界，不是优化可选项

Environment 专题在[environment.md](../architecture/environment.md)。Core 只看见：

```text
resolveBaseline → prepareRun → fingerprint → release
```

Recovery Agent 的内部 loop 不泄漏到 Orchestrator。Provider 是 `LocalWorkspaceProvider`。

安全边界的硬条件：

- 候选永远不在用户当前工作目录跑
- 无法建立隔离副本或受控观察绑定时，状态是 `unsupported`
- `release` 结束活动句柄，**不删除** `environment/runs/{runId}`，方便结果页打开对照
- symlink / junction 跳过；快照有文件数和字节预算（默认最多约 5 万文件 / 1 GiB）
- 敏感文件计数，原始凭据不进 trace

“任何任务”在产品定义里是架构开放性，不是恢复承诺。本地 Git 项目、文档目录、浏览器登录态、数据库副作用的可恢复程度完全不同。报告必须用 `comparisonClass` 和 limitation 把这件事写在脸上。

Windows 现实还会穿透到 Runtime：Codex 在 win32 上默认 `danger-full-access`，注释写明隔离靠冻结副本。优化环境时如果只谈 Linux sandbox，会和已验证平台错位。

---

## 十、事件日志是唯一事实来源，TUI 只是投影

持久化协议见[崩溃一致性](../architecture/persistence-and-crash-consistency.md)。第一版不用数据库。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 280" width="880" height="280" role="img" aria-label="事实面与展示面">
  <rect width="880" height="280" fill="#FBF8F3"/>
  <text x="40" y="38" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="22" font-weight="700" fill="#1C2430">事实面与展示面</text>

  <rect x="40" y="70" width="360" height="180" rx="16" fill="#EEF5FC" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="220" y="104" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" font-weight="700" fill="#3B7DC4">事实面 · 只追加</text>
  <text x="220" y="136" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">events.jsonl + 不可变 JSON</text>
  <text x="220" y="162" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">RunAttempt / RunManifest / artifacts</text>
  <text x="220" y="186" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">单写者 writer.lock</text>
  <text x="220" y="218" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">模型当时看见什么，必须能从这里复原</text>

  <path d="M412 160 L468 160" stroke="#3B7DC4" stroke-width="2" fill="none"/>
  <polygon points="468,154 480,160 468,166" fill="#3B7DC4"/>

  <rect x="488" y="70" width="352" height="180" rx="16" fill="#F7FBFF" stroke="#3B7DC4" stroke-width="1.6"/>
  <text x="664" y="104" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" font-weight="700" fill="#3B7DC4">展示面 · 可重建</text>
  <text x="664" y="136" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="14" font-weight="700" fill="#1E3A5F">TUI ViewModel / report.html</text>
  <text x="664" y="162" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">state.json · RunRecord · 时间线</text>
  <text x="664" y="186" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="13" fill="#5A6A7A">退出或重建不得改事实</text>
  <text x="664" y="218" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif" font-size="12" fill="#5A6A7A">禁止伪造未公开的推理过程</text>
</svg>
```

`ExperimentStore` 是单写者：分配 sequence、追加 JSONL、原子 rename 快照。TUI 通过 `onEvent` 订阅同一条流，再由 `src/tui/view-projection.ts` 变成页面模型。运行页是只读观看，页脚只留有效键。

纪律是：进入模型的内容必须能从日志复原。范围覆盖内部 Agent 的 prompt，也覆盖 Target 的 delivery、settlement、Controller 决策和环境 fingerprint。压缩、隐私过滤、脱敏发生在送出模型之前；过滤失败则阻塞该次调用，不用更多原文静默降级。

崩溃后的原则是：

```text
已持久化事实 + 当前外部状态 + 操作幂等性
```

delivery unknown 不重发；`finalizing` 不重新做任务；迟到事件不改 outcome。这比“从半个 Turn 中间无缝续跑”保守，也更不容易制造重复副作用。

---

## 十一、代码目录怎样表达依赖方向

```text
src/core/             领域对象、schema、状态机、Runtime 端口
src/application/      Case Preparation、CandidateRun 编排、TUI workflow
src/products/         Codex / Claude Code Pack
src/environment/      本地工作区 Provider 与恢复校验
src/agents/           三个 Agent 的 prompt、schema、端口
src/infrastructure/   Pi Host、Store、工具、进程
src/tui/              只读投影与交互
src/cli/              装配根
src/report/           报告落盘
```

层级门禁 `verify:imports` 守住方向：Core 不导入 Pack 或 Pi；Controller / Comparison 不导入 `products/`。

用户能摸到的装配根是 `src/cli/main.ts`：解析 `--data-dir` / `--sessions-dir` / `--compare`，启动 `CodexIntakeTui`。TUI 工作台页面包括 home、config、history、sessions、inspection、source、preflight、candidate 选择、confirm、running、compare-gate、result。页面多，但实验状态机仍只在 Application。

测试读 `dist/`。改源码必须先 `npm run build`。门禁是 `npm run check`；只改文档跑 `npm run verify:docs`。覆盖率阈值只升不降。真实 Runtime 必须环境变量 opt-in。

---

## 十二、关键设计为什么长成这样

这些选择在[架构研究基础](./architecture-foundations.md)和决策记录里有完整备选方案。导读只保留对后续优化仍有约束力的几条。

**真实任务，而不是经典题目。**  
个人效用来自用户自己的历史会话。一旦把会话改写成统一 benchmark，产品就变成公共榜单，变量控制也会假干净。

**动态协作，而不是消息 replay。**  
候选轨迹一变，原用户的第二句可能变得荒谬。Controller 成本高、不确定性高，却是这个产品成立的条件。

**证据展示，而不是统一打分。**  
任务类型开放，没有稳定 rubric。Comparison 若输出分数，用户会把它当成榜单。

**诚实降级，而不是假装公平。**  
恢复不全就标 `partial` / `exploratory` / `observational`，仍然允许探索性运行。静默补齐文件或猜测模型身份，会让对照不可信。

**端口隔离产品，而不是 if (productId)。**  
第三个 Product Pack 应该只新增适配，不改 Orchestrator 分支。当前两个 Pack 已开始把排序、进程超时收到 `products/shared/`，但会话诊断和 Runtime 细节仍大量重复。

**单进程文件协议，而不是数据库。**  
实验数量是个人级。可靠性来自原子提交和单写者，不来自分布式一致性。

**TUI 不持有状态机。**  
终端可以退出。事实必须留在 `data/experiments/<id>/`。

---

## 十三、现有问题：优化前先看清结构张力

下面不是缺陷清单，而是架构已经显形、下一轮优化必须正面处理的张力。规范文档描述目标形状；代码和目录暴露摩擦。

### 1. 外环套内环，成本天然相乘

一次候选运行里至少套了三层循环：

```text
CandidateRun 状态机
  └─ Target Runtime 自己的 Agent Loop（被测模型 + 产品工具）
  └─ 每个 settlement 后的 Controller Pi session（内部模型 + 工作区工具）
```

Recovery 和 Comparison 还各有完整工具循环。用户看见的是“换个模型再跑一次”，账单和时间线是：目标模型费用 + 内部模型费用 + 工作区复制 + 多进程常驻。

优化若只加速 TUI 渲染，碰不到这条主成本。值得做的是让内部 Agent 的可见输入更小、调用更少、停机更准，以及让隔离复制可增量、可预算可见。

### 2. 编排层仍是单点引力

`startCodexExperiment` 仍集中在接近源码上限的 `experiment.ts`（allowlist 宽限到 2026-10-01）。它同时协调：状态机驱动、briefing 磁盘、Controller 预读、无进展、完成证据守卫、artifact、对照门。Recovery 已拆成 `experiment-recovery-*` 一簇，阅读时却要在十几个文件间跳转。

这不是“再加一个 workflow DSL”能解决的。更稳的方向是按生命周期切纯函数模块：准备、开场、运行环、收尾、对照，让 `CandidateRun` 继续做状态钉子，让 experiment 文件不再既是内核又是胶水。

### 3. 产品名泄漏进公共路径

`CodexExperiment*`、`recoverCodexExperiment`、`CodexIntakeTui`、`createCodexExperimentWorkflow` 已经服务 Claude Code。对阅读者，这像还有一条 Codex 专用内核。对修改者，重命名是一次跨 TUI / 测试 / 文档的大移动，不做则第三个 Pack 会继续复制这套前缀。

这是命名债务，也是边界信号：Application 层在第一份纵切片时按产品切开，后来用同一条路径承载多 Pack，名字没跟上端口。

### 4. Pack 共享层薄，第三个实现会放大重复

两个 Runtime 都要：发现可执行文件、spawn、RPC 超时、turn settlement 分类、会话 JSONL 流式读取、项目归属。`jscpd` 已经能看见相同片段。共享层若抽得过早，会把产品差异塞进布尔参数；抽得过晚，第三个 Pack 会变成又一份拷贝。

原则应保持：只提取两份实现已经证明确实相同的 helper；产品私有 JSON 形状继续留在 Pack 内。

### 5. schema.ts 仍是持久化契约的单文件

外部 JSON、模型输出、磁盘快照都必须 `Value.Check`。把所有 TypeBox 放在一个快到 1000 行的文件里，改一个信封字段的回归半径覆盖 Store、三个 Agent、TUI 和测试夹具。按领域对象拆文件、由入口再导出，不改变校验纪律，只缩小每次 diff。

### 6. TUI 状态组合已经比领域状态机更宽

领域只有七个 CandidateRun 状态。工作台页面有十几个，再加上 intake 分层、候选产品/模型选择、恢复确认、对照门、overlay、时间线折叠。`view-projection.ts` 正在把快照变成渲染模型，但 Intake 控制器本身仍很大。

风险是：改一条恢复文案同时碰到 i18n、帧审计、workflow、recovery 分类。帧基线保护视觉回归，保护不了“业务状态和渲染数据缠在一起”的修改成本。

### 7. Controller 的正确性几乎无法用分数证明

同等人类能力没有标准答案。系统能验证的是：schema、工具权限、决策落盘、不投递冻结封面、证据引用归属、停机码不被冒充。无法验证“这句用户输入像原用户”。

于是产品质量会集中在 briefing、understanding pass、完成证据守卫和 prompt 上。这些材料一变，就要决策记录和快照。优化 prompt 却不更新“模型可见输入事件”，会直接违反可追溯纪律。

### 8. 恢复能力与“任何任务”叙事之间有缺口

架构允许浏览器、数据库、桌面应用。当前可验证路径仍以本机工作区快照和 Git 线索为主。复杂非空项目、外部登录态、不可逆副作用会落到 observational。产品文案若让人以为选任意历史会话都能严格对照，信任会在第一次 partial 恢复时破裂。

优化恢复，应先提高一类高价值环境的证据质量（例如 Git 项目的开始时点），而不是平行铺新环境类型。

### 9. 内部三个 Agent 绑死同一套用户模型配置

`createHarnessAgents` 从一个 `HarnessModelConfig` 构造三角色。用户选的是“Harness 内部模型”，不是“恢复用 A、协作用 B、对照用 C”。便宜或短上下文的模型可能撑不起 Controller 的完整会话理解；强模型又让 Recovery 调查偏贵。

这是产品简化，也是效果上限。以后若拆开配置，必须按 Experiment 冻结，不能让 setup 页事后改掉已有实验。

### 10. 文档与代码的权威层级清晰，体积已经构成导航税

`architecture/` 是规范，`decisions/` 锁选择，`plan/` 堆未完成工作，`research/` 可推翻。这个分层是对的。代价是：同一条 Controller 规则会同时出现在总览、专题、实验条件、多篇决策和多篇计划里。新人（和 Agent）会读到过期计划。

后续优化文档时，应把计划迁出或标明终止，而不是再写第三份总览。本文也遵守这条：类型定义只链回总览。

### 11. 展示面仍有“活状态”与“可重建投影”的缝

原则是 TUI 只读事件。运行中为了跟手，工作台持有 timeline 缓冲、phase、取消标志。进程被杀后，这些活状态消失，磁盘上的 `events.jsonl` 才是真相。缝存在于：运行中 UI 是否可能显示尚未提交的推断（例如把模型自述当完成）。当前用 `agent.assistant_visible` 和 fold 过程来约束，但仍要当回归面看管。

### 12. 平台特殊性写进了 Runtime 默认值

Windows 11 是唯一已验证平台。`.cmd` spawn、PowerShell 回退、Codex sandbox 默认值都按这个前提编码。跨平台 Host 决策已经存在，但“在 Ubuntu 上逐字节比 TUI 帧”被明确拒绝。任何“抽象掉 Windows”的重构，都可能把已验证路径改坏。

---

## 十四、优化时建议保持的顺序

这些顺序来自结构本身，不是一份新的开发计划。

```text
1. 让对照实验的主成本可见：分段耗时、内部/目标调用次数、副本大小
2. 拆开 experiment 编排与 schema 文件，不改 on-disk 格式
3. 只提取 Pack 间已证实相同的 helper
4. 收紧 Controller 停机与 briefing，减少空转 turn
5. 再考虑第三个 Product Pack、无头 CLI、更复杂环境
```

不建议用这些手段“优化”：

- 把两个 Pack 合并成万能适配器
- 让 TUI 或 Comparison 写回 CandidateRun 状态
- 用统一质量分代替证据
- 默认开启真实 Runtime 或自动清理用户数据
- 为了过覆盖率去测试死代码，而不是删除它
- 引入插件市场或工作流引擎来消化当前的文件长度

---

## 写在最后

Reprise 把对照实验拆成两个层次。

目标产品里的模型负责在隔离副本中做那件历史任务。Harness 负责：把产品私有世界翻译成公共协议，恢复并复制环境，在每个稳定输入边界扮演原用户，把看见过和做过的事写成只能追加的日志，再按需生成对照报告。

它追求的是一条很窄的主张：

```text
模型是唯一有意改变的变量
办公室（Runtime、环境、协作者、预算）尽量固定
不能固定的条件必须被看见
```

以后讨论“Reprise 好不好用”，除了问内部用了哪个模型，还要问：TaskCase 冻的是不是完整逻辑会话、环境恢复到哪一类 fidelity、Controller 看见的是路径还是剧透、Target 的 settlement 有没有原生证据、以及一次失败能不能从 `events.jsonl` 还原。

公共协议继续以[架构总览](../architecture/overview.md)为准。本文只负责把那份规范读成可走的地图，并标出路上已经能看见的裂缝。
