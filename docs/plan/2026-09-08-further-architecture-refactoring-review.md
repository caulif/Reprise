# Reprise 架构重构进一步审查与实施计划

> 审查日期：2026-09-08  
> 审查范围：当前工作区源码与测试、架构重构规划、Session harness 决策、TUI 规划及 MASTER 进度记录。  
> 文档性质：下一阶段实施依据，不代表重构已经完成。

## 1. 审查结论

当前代码已推进一轮大规模迁移，但第 8 节确认仍有 CLI 与活动生命周期差距，须优先修复。，核心目标中的大部分结构已有源码、测试和 ADR 支撑：Agent Session/Invocation 生命周期、模型输入事件重建、Recovery 连续 Session、场景封存与重复运行、CandidateRun 活动所有权、Controller 单 Session、Comparison 单 Session、共享 Workflow、CLI 查询协议、跨终端取消和本地 Pack 注册均已出现对应实现。

但项目还不能宣称完全按照目标架构完成。除第 8 节源码差距外，另有四类收口事项：

1. **运行时真实性证据不足**：测试主要证明模拟运行和合同路径，尚未完成真实 `streamFn` 的逐次 context 对拍、真实付费模型 Controller lane，以及授权后的 Runtime smoke。
2. **终端交互证据不完整**：Windows Terminal 有部分人工证据，macOS/Linux 真终端和三平台 IME/滚轮/拖选/退出恢复仍未闭环。
3. **目标决策尚未生效**：核心目标决策仍位于 `proposed`，当前规范与目标规划存在“实施已做、规范未收口”的状态差异。
4. **代码组织已收敛但仍偏扁平**：`src/application` 聚集了大量实验、Recovery、CLI/TUI 适配和查询文件；这不违反当前依赖方向，但后续维护需要用所有权边界和入口契约继续压缩，而不是继续增加通用层。

因此下一阶段目标应是“证据闭环、契约生效、删除遗留路径、压缩边界”，而不是再做一次大规模目录重写。

## 2. 目标与当前状态对照

| 目标区域 | 当前判断 | 证据/定位 | 进一步动作 |
|---|---|---|---|
| Agent 执行机制 | 基本落地，真实性未闭环 | `src/infrastructure/pi-agent-host.ts`、`pi-model-caller.ts`、`pi-compaction.ts`；M1 ADR 与测试 | 增加真实模型 context 对拍；确认每次请求前持久化输入、压缩和修复后的顺序 |
| Session/Invocation | 已落地 | `pi-agent-host.ts`；`agent-session-lifecycle.test.ts`、`agent-model-input.test.ts` | 增加崩溃窗口、写入失败、晚到响应的端到端验证 |
| Harness 业务所有权 | 已落地但需持续守边界 | `candidate-run.ts`、`experiment-scene.ts`、Recovery 系列 | 检查所有业务状态转换仍只经 `assertTransition`；删除重复结果判断 |
| Recovery | 已落地 | `experiment-recovery-run*.ts`、`recovery-agent.ts` | 对证据不足、源目录变化、权限失败做跨进程/真实文件系统验证 |
| Controller | 结构落地，语义能力未证明 | `controller-agent.ts`、`controller-request.ts`、能力 lane | 先完成付费 lane；记录失败分类；不把合同 lane 当作语义等价证明 |
| Comparison | 已落地 | `comparison.ts`、`comparison-agent.ts`；单 Session 测试 | 验证历史重开、失败 attempt、不覆盖旧报告和候选 Runtime 隔离 |
| Workflow | 已落地 | `experiment-workflow.ts`、`experiment-operations.ts` | 继续确保 CLI/TUI 只调用公共操作；禁止页面发请求或持状态机 |
| CLI | 大部分落地 | `cli/main.ts`、`headless.ts`、`protocol.ts`、`query.ts` | 固定错误 kind/退出码；补充长运行、SIGINT、JSONL EOF 和跨终端 cancel 证据 |
| TUI | 结构落地，真实终端未闭环 | `src/tui`、`tui-workflow.ts`；回放帧 | 完成三平台真实终端验收；检查视图只读投影和动态追加时选区稳定 |
| Product Pack | 已落地 | `products/registry.ts`、`pack-access.ts`、第三 Pack 测试 | 继续验证缺能力诊断、重复身份、历史查询不加载 Pack |
| 持久化与历史 | 基本落地 | `experiment-store.ts`、`schema.ts`、历史 reader | 补损坏尾、旧版本、部分提交和路径边界的组合测试 |
| 平台与 Runtime | 代码已迁移，实机证据不足 | `platform.ts`、`process-runner.ts`、`products/shared/process.ts` | 在授权和显式 opt-in 下补 Runtime smoke；记录三 OS 结果 |
| 文档/决策 | 实施记录丰富，规范状态未完全收口 | `docs/decisions/proposed/...`、`MASTER.md` | 逐项把已稳定契约同步到 accepted/current architecture；保留未验证项为明确缺口 |

## 3. 关键架构风险

### 3.1 真实模型输入可能与持久化事实不一致

`pi-agent-host.ts`、`pi-model-caller.ts` 和压缩逻辑已经具备输入记录与恢复路径，但当前证据主要来自可控调用器。风险是生产 `streamFn` 在以下边界改变实际 context：工具结果追加、原生内容块、修复重试、压缩后 retained tail、系统提示词或工具 schema 变化。

**要求**：为一次真实调用建立可脱敏的 context digest 对拍记录，只保存结构摘要、顺序、消息角色、块类型、大小和 digest，不保存密钥或不必要的模型原文。每次进入 provider 前校验记录已写入；写入失败必须阻止模型调用。

**验收**：同一 fixture 分别覆盖无工具、工具往返、压缩、结构化输出修复、取消和 provider 错误；断言事件日志能够重建实际请求序列，且失败不会伪造 `completed`。

### 3.2 Controller 真实能力不能由合同 lane 代替

`docs/progress/MASTER.md` 已明确真实 Controller lane 五族代表未匹配。合同测试可以证明 Host 对合法结果的处理，不能证明模型能在历史证据、冲突工具结果、无进展和权限不足下稳定作出正确 `send/done` 决定。

**要求**：将付费模型测试作为显式环境变量控制的独立 lane；报告只输出 case、状态、错误分类和期望/实际动作摘要，不输出模型原文、凭据或完整敏感上下文。若模型能力不足，记录为模型能力结果，不通过修改生产守卫掩盖。

### 3.3 TUI 仍需从“回放正确”走到“终端正确”

回放帧已覆盖宽窄布局、中文、折叠、搜索和时间线；MASTER 仍记录真实终端 IME、滚轮、拖选及 macOS/Linux 证据缺失。终端输入是平台边界，不能用 Cursor 合成 Unicode 输入替代 IME 证据。

**要求**：定义每个系统/终端的最小验收矩阵，人工执行并保存版本、环境变量、结果和失败原因。测试内容包括中文输入、IME 组字、滚轮、拖选复制、缩放、键盘导航、Ctrl+C、异常退出和历史重开。

### 3.4 proposed 决策与当前代码存在生命周期错位

`docs/decisions/accepted/2026-09-07-reprise-session-harness-workflow.md` 约束现行入口。未关闭的真实证据单独保留，不能写成已支持。

**要求**：完成未关闭证据后，将稳定部分迁入 accepted，并同步 `docs/architecture/overview.md`、依赖方向、持久化、TUI 和 Pack 规范；未完成的真实证据单独保留为验收缺口，不能写成已支持。

### 3.5 application 目录需要按所有权审查，而非继续分层

当前文件数量较多，尤其是 `experiment-*` 和 Recovery 文件。风险不是目录多本身，而是同一业务决定被多个入口重复解释。

**要求**：建立静态审查表：每个公开操作只有一个应用所有者；CLI/TUI 只能组装输入和渲染；Pack 只提供产品能力；存储只负责事实读写；查询不实例化 Runtime。发现重复逻辑时删除或调用已有 helper，不新增 workflow engine、DI 容器或“通用能力层”。

## 4. 分阶段实施计划

### P0：冻结审查基线

- 保留当前用户工作区改动，不重置或覆盖已有修改。
- 记录当前 `git status --short`、HEAD 和本审查文档。
- 运行 `npm run verify:docs`，修复链接、标题、文档状态和过期“已完成”表述。
- 对照 `MASTER.md` 重新列出 A1–A18、TUI 验收、Runtime smoke、Controller lane 的状态。

出口：所有结论均能链接源码、测试或日志；没有“基本完成”“只剩测试”这类无证据状态。

### P1：Agent 真实输入对拍

- 新增脱敏的 provider/streamFn probe，仅在显式 opt-in 时运行。
- 覆盖工具往返、原生块、压缩、修复、重试、取消、写入失败。
- 校验事件顺序、`agent_model_input` 附件、request ID、invocation ID 和 session ID。
- 明确 provider 重试与 Host 重试的唯一责任人。

出口：生产路径每次模型请求都能由事件日志复原；对拍失败时测试失败并指出第一处 digest 差异。

### P2：Controller 真实模型 lane

- 复用已有 `evaluate:controller` 入口和 fixture。
- 将付费运行与默认检查严格分开，默认路径不得产生模型费用。
- 报告只保存脱敏摘要；为每个 case 记录成功、协议失败、模型能力失败、环境失败或取消。
- 不将 lane 失败转化为生产规则，也不放宽 schema 以适配散文输出。

出口：每个代表性 case 有可复核结果；若仍失败，MASTER 明确保留“模型能力未达标”。

### P3：CLI/跨进程验收收口

- 验证 `run` 默认在候选结束后退出，`--compare` 才执行对照。
- 验证失败 run 非零退出；JSON/JSONL stdout 不混日志；JSONL 首条为 activity，异常 EOF 可查询。
- 验证 SIGINT、跨终端 cancel、重复 cancel、旧 operationId、死端点、清理超时和未知状态。
- 验证 `history/events` 不加载 Pack，不读锁/PID 推断活动。

出口：每个命令有稳定 error kind、退出码和最小可复现命令；至少一个子进程级测试证明另一终端取消实际生效。

### P4：三平台真实 TUI 与 Runtime 证据

- Windows Terminal/PowerShell：补齐尚未验证的 IME、滚轮、拖选、退出恢复。
- macOS Terminal/Bash：执行同一矩阵并保存终端版本。
- Linux 选定终端/Bash：执行同一矩阵并保存终端版本。
- 在明确授权和环境变量 opt-in 后，分别验证候选 Runtime 启停、取消、非零退出、输出上限和清理超时。

出口：支持声明只覆盖有证据的平台/终端组合；未验证组合明确显示 unsupported 或 unverified。

### P5：规范生效与遗留删除

- 将 Session harness workflow 决策从 proposed 迁入 accepted，或拆成已稳定和未决两份记录。
- 更新架构总览、TUI、Pack、持久化和验证文档，使其描述当前代码与真实支持范围。
- 删除无调用兼容别名、重复入口、死代码和过时“已完成”文档；不要为死代码补覆盖率。
- 运行依赖方向、源码大小、未使用导出、敏感信息和 tracked source 门禁。

出口：新开发者只读受控文档即可理解入口、所有权、状态、持久化和未关闭风险。

## 5. 每批次必须执行的验证

文档变更：

```text
npm run verify:docs
```

源码变更：

```text
npm run build
npm run check
```

额外按批次运行相关 `dist/test/*.test.js`。真实模型和 Runtime 只能通过显式 opt-in 命令执行，默认检查不得发起外部付费请求。TUI 变化需更新回放帧并审阅差异；真实终端结果保存到本机不受控证据目录，不把凭据或模型原文写入仓库。

## 6. 完成定义

只有同时满足以下条件，才能把本轮架构重构标记为完成：

- 所有目标公开入口由同一 Workflow/应用操作实现，TUI 没有业务状态机。
- 三类角色的 Session 边界、工具副作用和业务检查所有权可由代码定位。
- CandidateRun 状态转换只有一个入口，持久化和模型输入均可复原。
- 历史、事件、配置、模型输出和外部 JSON 均经过 schema 边界校验；秘密不进入日志、artifact、报告或 argv。
- CLI 协议、取消、失败退出和重复运行有子进程级证据。
- Product Pack 通过显式注册和能力校验扩展，宿主没有产品类型分支。
- Agent 真实输入对拍、Controller 真实 lane、授权 Runtime smoke 和三平台终端矩阵均有结果；失败项必须明确标记，不能用单元测试替代。
- accepted 规范、架构总览、TUI 规划、实施计划和 MASTER 的状态一致。

## 7. 不应继续扩大的范围

本计划不引入通用 workflow engine、DI 容器、后台 daemon、远程运行、跨机历史迁移、会话续跑、运行中模型切换、插件市场、第二套 Agent Host 或隐藏推理展示。若后续发现问题可以由现有 helper、标准库或 Pi 能力解决，应优先复用并删除重复代码。

## 8. 本轮源码确认的差距（优先于 P1–P5）

以下为当前工作区静态调用链确认，尚未执行运行时复现；实施前必须以最小反向用例确认。前文“已落地”仅表示已有结构或既有实施记录，不表示本轮重新验证通过。审查基线 HEAD 为 `efc67ac`，但实际对象包括大量 staged/unstaged 修改，不能仅以 HEAD 复现。

### F1 / 高：prepare 的来源产品被当成候选产品校验

定位：`src/cli/headless.ts` 的 `runSourceOrScenario`、`candidateFromFlags`、`resolvePrepareSource`。

帮助明确允许 `prepare --product <id> --source-path <path>`。但进入 prepare 分支之前先调用 `candidateFromFlags`，它要求 `--product` 与 `--model` 成对。正常来源准备命令因此会在导入之前抛 usage 错误；补上 model 只是绕过校验，不符合 prepare 的职责。

根因是来源与候选共用一个 `product` 字段，命令职责未拆开。最小动作：prepare 不解析候选参数；完整 run 分开 source 与 candidate 的身份解析。参数名可由实施决定，但不能用同一个字段承担两个角色。

验收：只带来源 product/source-path 能进入准备；来源 A 与候选 B 的完整运行可用；非法组合在导入或模型调用之前失败。覆盖实际命令解析，不能只测试应用函数。

### F2 / 高：活动记录输出过晚，而且部分 operationId 为虚构身份

定位：`src/cli/headless.ts` 的 `runSourceOrScenario`、`runPersistedCompare`、`settleHandle`；`src/application/experiment-activity.ts` 的 `registerActivity`。

prepare 在 `await prepareExperiment(...)` 后才输出 activity，期间 `onEvent` 已直接输出事件。完整 run 也等待 `runFullExperiment` 完成准备后才进入 `settleHandle` 输出活动。这与 JSONL 首条为活动标识、耗时工作前可取消的目标冲突。

此外，prepare 拼出 `op-prepare-${experimentId}`，独立 compare 拼出 `op-compare-${experimentId}`；真实注册则为 `op-${kind}-${randomUUID()}`。这些输出不能作为真实 operationId 可靠取消。prepare 还把 experimentId 填入 runId，失去字段语义。

最小动作：由应用所有者发布真实活动身份与 control-ready 事实，两种界面订阅；CLI 不推导身份。准备、运行、对照阶段分别发布真实边界，不用一个假 ID 覆盖整个流程。

验收：以慢速脚本 Recovery 阻塞，在其返回前获取首条 activity，通过第二个进程使用该 operationId 取消；compare 重复 attempt 身份不同；任何 event 均在对应活动首记录后输出。

### F3 / 高：SIGINT 安装范围未覆盖 prepare 与独立 compare

定位：`src/cli/headless.ts` 的 `attachSigint`、`settleHandle`、`runPersistedCompare`。

SIGINT 监听只在 handle 已返回的 `settleHandle` 中安装。独立 prepare 不经过此函数；独立 compare 直接 await `workflow.comparePersisted`；完整 run 的准备阶段也早于监听安装。该文件中的 `timeoutSignal` 只有 timeout，不合并 SIGINT。

最小动作：前台命令入口拥有一次取消控制器，在第一个异步业务动作前安装信号处理，并将统一 signal 传递给 prepare/run/compare；finally 清理监听。应用所有者继续记录终态和清理结果，不让 CLI 自造已取消。

验收：分别在慢速 prepare、候选 run、独立 compare 期间向子进程发送 Ctrl+C/平台等价信号，确认持久化取消与有界清理；重复信号和自然完成竞争不改写终态。

### F4 / 中：机器响应未经过输出 schema 校验

定位：`src/cli/protocol.ts` 的 `writeJsonResult` 与 `writeJsonl`。

当前两者直接 `JSON.stringify`，TypeScript 类型并不是目标要求的 JSON 外部边界 `Value.Check`。`writeJsonResult` 的 data 仍允许 unknown，实际是否存在更深 schema 约束需要实施时补齐。

最小动作：在统一序列化入口复用公共响应 schema 校验；不要给每个同进程调用额外加运行时校验。

验收：传入非法公共信封时拒绝输出；正常 query/run/error/jsonl 输出通过对应 schema；若调整门禁，须同批提供能让门禁失败的自动化用例。

### F5 / 中：插件仍通过全局激活表被应用查询

定位：`src/cli/headless.ts` 的 `loadAndActivateProductPacks`；`src/application/experiment-workflow.ts` 的 `packFor` 回退 `findProductPack`。

目标要求注册表由启动装配处加载并注入。当前已有显式插件加载，但 Workflow 仍依赖全局查找，单个 `input.pack` 的注入不能表达完整来源/候选注册表。此处是依赖所有权差距，不据此推断已有跨实验串扰。

最小动作：让启动处提供一个已解析的 registry/lookup，复用现有注册表类型；Workflow 消费该对象，不建立 DI 框架。验证两个不同 dataDir 的装配互不覆盖，以及缺插件时已保存历史仍可读取。

### F6 / 待补证：首次模型探测与配置快照边界

定位：`src/application/experiment-workflow.ts` 的 `recover`、`start`、`createHarnessWorkflow`。

recover 在生成实验 ID 之前 `await input.agents`，后者可以执行实际付费的 `caller.validate`。start 再调用 agents 并重读配置，缓存以配置内容作 key。需要进一步核查 probe 是否受完整 opt-in 保护，以及 prepare 与 run 之间配置修改是否造成未声明的模型切换；仅凭该文件不能宣称费用准入已被绕过。

验收：首次耗时探测前已有可查询/可取消操作；默认环境不发请求；同一活动流程配置变化不会静默替换快照，独立的新 run 可以采用新快照并记录。

## 9. 修订后的实施顺序与证据说明

实际优先级为：F1 来源/候选分离 → F2/F3 统一活动生命周期与取消 → F4 输出协议 → F5 注册表注入 → F6 快照与探测核查 → P1–P5 真实性和规范收口。F2/F3 应作为同一边界变更，更新相应 ADR；其他项尽量独立提交评审，未经用户指令不提交 Git。

参考入口：

- [目标架构](reprise-architecture-redesign.md)
- 目标架构交互图：本机 `docs/research/reprise-architecture-redesign.html`（不受控参考）
- [目标决策](../decisions/accepted/2026-09-07-reprise-session-harness-workflow.md)
- [TUI 目标](reprise-tui-design.md)
- TUI 交互预览：本机 `docs/research/reprise-tui-design.html`（不受控参考）
- [既有实施计划](reprise-refactoring-execution.md)
- [既有完成记录](../progress/MASTER.md)

本轮完成的是文档和调用链审查，不是整个项目测试复验。未执行真实模型、Runtime、浏览器交互或三平台终端；HTML 仅作源码内容核对。没有逐行审计全部源码，也未将历史 MASTER 的通过记录冒充本轮验证。下一轮应优先用 F1–F3 的免费模拟反向用例证伪“机械迁移已完全关闭”，再扩展真实环境验收。

