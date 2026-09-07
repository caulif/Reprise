# Reprise 架构重构规划

状态：已确认的目标设计；当前实现仍以 `architecture/` 和 `decisions/accepted/` 为准。

## 目标

Reprise 在本机从历史会话准备场景，运行候选 coding agent，并让用户查看结果或独立发起对照。它不是通用 Agent 框架、后台服务、跨机实验平台或断点续跑系统。

用户路径固定为：配置内部模型、选择历史会话、选择候选 coding agent 和模型、启动、查看结果路径、按需发起对照。运行期间只可查看进度和取消；不能追加指令、暂停续跑或换模型。恢复证据不足时保存调查与原因并停止，不提供强行接受的入口。

目标支持 Windows、macOS、Linux 各自在本机运行本机任务并查看本机历史。Windows 默认 PowerShell；macOS/Linux 默认 Bash。范围不含跨系统重放、跨机迁移、远程运行和常驻 daemon。

## 职责与依赖

系统是模块化单体，不建立 L0-L2 六层、通用 workflow engine、DI 容器或 Workbench/Brief/Verifier/Audit 五件套内核。

```text
CLI / TUI
    ↓
Workflow
    ↓
Reprise harness ───── Environment / Product Pack / storage
    ↓
Agent execution
    ↓
Pi Agent / pi-ai provider / injected tools
```

| 职责 | 拥有内容 | 不拥有内容 |
| --- | --- | --- |
| Agent execution | Session、Invocation、消息、工具 loop、压缩、取消、事件、结构化输出、用量与持久化 | 场景是否可用、候选投递、任务结果、报告发布 |
| Reprise harness | 三角色行为、权限、场景准备、CandidateRun、业务检查和结果 | TUI 导航、provider 私有协议 |
| Workflow | 配置与选择顺序、取消传播、历史/结果入口、独立对照 | Agent 工具循环、候选 turn 判断、工具内部文件操作 |
| CLI / TUI | 同一 workflow 的操作入口与只读投影 | 实验状态机、业务接受、产品策略 |

Workbench、Brief、Verifier、Audit 是可能存在于各角色实现中的职责，分别归工具/环境、输入准备、业务检查和事件记录所有者；它们不是跨模块的必建子系统。产物类型和 Schema 也不属于最低层：持久化、外部输入和模型输出在其边界校验，领域语义由对应 harness 功能拥有。

## Agent 执行机制

Session 是一个角色的持续对话，拥有稳定 ID、模型配置快照、消息历史和最多一个活动 Invocation。Invocation 是 harness 发起的一次请求，可包含多次模型请求、工具执行、压缩和输出修复。不同实验、不同角色和不同 CandidateRun 不共享 Session。

执行机制必须提供：

- Pi Agent 的模型响应、工具执行、工具结果和下一轮响应 loop；
- pi-ai provider 与模型目录适配，保留模型能力、实际身份和用量；
- 文本、图像、工具调用及工具结果的结构化消息，不能压平成字符串；
- 由 harness 注入并实施权限的工具；
- 消息、请求和工具活动的有序事件，关联 experiment、session、invocation 和 request；
- 可重建的压缩记录，包含 summary、retained tail、触发原因和用量；
- 取消向模型和工具传播；取消不回滚已经发生的文件副作用；
- 有唯一所有者的重试和结构化输出修复，避免 provider/Host 重试叠乘；
- 顺序持久化。写入失败时不能宣告 Invocation 成功。

完整消息历史与运行上下文分离：压缩只改变后续输入，不删除历史。退出程序后可以重新打开，读取完整已持久化过程；不会自动继续、重放消息或重新启动 Runtime。

Pi 0.84.1 的 Agent loop、provider、工具调度和事件可直接复用。高级 `AgentHarness` 的 `prompt`、`compact`、`resume` 在该版本仍有未实现分支，不能作为必需路径。Reprise 不同时维护两份会话事实源。

## 角色与会话

三个内部角色共享一份内部模型配置，但各自使用独立连续 Session。

| 角色 | Session 范围 | 权限和产物 |
| --- | --- | --- |
| Recovery | 一次场景准备 | 历史/证据只读，只写受控恢复副本；证据与检查足够时封存场景 |
| Controller | 一次 CandidateRun | 只读历史和当前候选结果；首次 Invocation 直接理解历史并生成 opening，后续决定 send 或 done |
| Comparison | 一次 comparison attempt | 只读历史、运行记录和候选结果；写 attempt 工作目录与报告 |

Controller 模拟原用户的协作和停止习惯。历史用户语句是目标、偏好、授权和行为证据，不是按序重放脚本；历史 agent 的发现不是原用户先验。Controller 不是严格验收器，“读过文件”“账本为空”“报告存在”等程序条件不能证明任务完成。

Comparison 可以在一个连续 Session 内调查、规划、撰写和修订；不强制 Planner/Reporter 双会话。Recovery、Controller、Comparison 的具体 prompt、工具与业务检查跟随各自 harness 模块维护。

## Workflow 与状态

正常流程：

1. 读取内部模型配置，选择来源产品、项目与历史会话，核对任务起点。
2. 检查准备所需条件和模型调用准入，导入并冻结 TaskCase，准备场景；证据不足则结束。
3. 场景可用后选择候选 Product Pack 和候选模型，检查运行条件并确认启动。
4. 从封存场景创建候选副本，启动 CandidateRun 和 Controller Session。
5. Controller 形成 opening；harness 先持久化决定，再投递候选。
6. 在公开 settlement 边界保存候选事实；Controller 在同一 Session 决定 send 或 done。
7. 收尾 Runtime、目录和会话，保存结果与清理事实。
8. 用户打开产物或从当前/历史 run 独立发起 Comparison。

Agent 执行机制管理 Invocation 状态。CandidateRun 管理准备、启动、等待候选、等待 Controller、收尾和完成，状态转换继续通过唯一 `assertTransition` 入口。冻结、列表查询和独立对照是普通函数和明确结果，不为了形式建立状态机。

任务判断、终止原因与清理结果保持正交。投递 `unknown` 不自动重发；进程崩溃后展示 interrupted/unknown，不猜测子进程状态，也不自动恢复。

## CLI、TUI 与本机控制

CLI 与 TUI 使用同一 Workflow，功能对等。CLI 应覆盖配置、认证、产品/模型/会话查询、`prepare`、`run --scenario`、完整 `run`、历史、事件、`cancel`、`compare` 和产物打开。机器输出使用版本化 `--json` 或 `--jsonl`，stdout 不混入日志。

完整 run 与 prepare → run --scenario → compare 共用应用操作，不维护第二套编排。非交互 CLI 可提前提供候选配置，但候选启动仍在场景封存之后。缺少必要配置明确报错，不能等待隐藏提示。来源身份为 productId + sessionId，歧义时使用列表返回的 sourcePath；来源与候选产品分别表达，不按标题或列表序号定位。场景与历史来源参数互斥。认证不通过日志、事件或命令行参数传递秘密。

--json 返回单个版本化结果；--jsonl 返回版本化事件流，首条含活动 ID，正常结束有终态记录，两者互斥。进度与诊断写 stderr。EOF 不能证明成功；按已保存状态查询。查询失败实验本身可以成功退出，业务未完成与命令失败分开；用法、未找到、能力不足、锁冲突、取消、超时等使用稳定错误分类与退出码。事件可按序号继续读取，不泄露控制凭据。

活动 CLI/TUI 进程是实验唯一写者。另一终端发送取消请求时，Windows 使用受限命名管道，macOS/Linux 使用私有目录中的 Unix socket；取消请求验证版本、长度、活动所有者与本机认证材料。它不是公网服务，也不允许未鉴权 TCP 回退。

同一 dataDir 下 cancel <id> 可取消 CLI 或 TUI 所有者的 prepare、run、compare。绑定精确操作与所有者实例，不能漂移到下一操作。已接收不等于已取消；有界等待到期只报告已知状态。重复请求与自然结束竞态安全。端点不可达、过期或 PID 复用时返回未知，不删除 writer.lock、不按旧 PID 杀进程、不接管写者。清理由活动所有者负责，清理失败与取消分别保留。锁按实验而非全 dataDir 设置；同一实验的对照与其他写操作冲突时拒绝。只读观察者退出不取消其他进程的工作。

TUI 只投影事件日志和活动事实，不持有实验状态机或生成隐藏推理。详细页面与键盘交互见 [TUI 设计](./reprise-tui-design.md)。

## 持久化与兼容性

持久化记录实验、Session、Invocation、消息、附件、工具事实、压缩、取消、运行结果和 Comparison attempt。外部 JSON、模型输出和磁盘记录都在边界做 schema 校验。秘密不进入事件、artifact、报告或模型上下文。

内部模型 provider 由 Pi/`pi-ai` 管理；候选 coding agent 由 Product Pack 管理。两条兼容路径分开。Pack 是显式配置的可信本地代码，提供版本化窄契约和能力声明；查看旧实验不需要执行原 Pack。

## 插件与场景的稳定边界

Product Pack 启动时加载显式配置的本地 JavaScript、TypeScript 编译产物或已安装包；不执行原始 TS、不自动下载、不热加载、不建设市场。插件按可信同进程代码处理，不能承诺隔离挂起或越权代码。拒绝重复 productId 和不兼容 API major，给出插件级诊断；不将全部宿主源码作为公共 API。

导入与运行能力分别声明，导入型或运行型插件都能独立展示。产品负责会话导入、恢复知识、候选模型目录、安装/认证状态与公开 Runtime 活动规范化；宿主负责权限、任务判断、状态与展示，不按产品类型写 UI 或 workflow 分支。插件不修改 Controller/Comparison 策略，不自行接受恢复结果。原生 ANSI 画面不作为公共活动协议；未知活动可通用降级展示。

场景封存后输入与版本不可变；重复 run 创建新 ID 和独立副本，初始指纹一致，不重新依赖源会话目录猜起点。对照使用终态封存快照，不读取仍变化的候选目录。Controller 提示词、协作策略、输入、压缩、干预消息与用量可追溯，不跨候选共享轨迹，不将产品配置差异解释为纯模型因果效果。

同一模型可有多轮工具调用；超时、重试、输出修复由明确所有者有界执行。压缩保留工具配对和可重建输入。模型输出合法不等于业务成功；可修复问题反馈原 Session，证据不足停止。业务检查跟随角色，不建设通用 Verifier。秘密过滤在进入日志与模型可见工具输出之前完成；发生脱敏记录遮蔽事实，不能承诺恢复原始秘密。

平台复用原生路径、进程与文件能力，处理大小写、中文与空格、权限、符号链接和进程树清理。Windows 不要求 Git Bash，WSL 按 Linux 本机处理，不混用 Windows 路径与 CLI。缺少 shell 或权限明确失败，不静默切换语义。CI 的模拟验证与实际 Runtime、终端和文件权限验证分别报告。

## 七批迁移

逐步改动、代码入口、依赖、失败验证与交接要求见[重构实施计划](./reprise-refactoring-execution.md)。本节拥有批次顺序，下文拥有目标验收；实施计划只细化执行。

1. 执行机制与持久化：建立唯一 Session/Invocation 事实源，收薄现有 Pi Host。
2. harness、场景与工具：迁移 Recovery、场景准备与 CandidateRun 状态所有权。
3. Controller：迁移为每 run 一个连续 Session，取消独立 Understanding 和强制 briefing。
4. Comparison：迁移为每 attempt 一个连续 Session，取消 Planner/Reporter 双会话。
5. Workflow 与 UI：实现对等 CLI/TUI、历史查看、独立对照和只读运行页。
6. 平台与 Pack：实现 PowerShell/Bash、本机 IPC、进程取消和 Windows/macOS/Linux 契约验证。
7. 文档收口：同步当前规范、ADR、导航、TUI 基线和过时材料迁移。

## 验收

下列条件是目标验收编号；不是已通过的测试清单。真实调用保持显式 opt-in，默认使用模拟 provider/Runtime。

| 编号 | 可观察条件 |
|---|---|
| A1 | Pi loop、Session 存储和压缩经公开 API 行为验证，不依赖占位实现 |
| A2 | Recovery、Controller、Comparison 按操作范围各复用一个连续 Session |
| A3 | Controller 首次请求理解并形成 opening，无独立 Understanding；人工样例评估协作与停止习惯 |
| A4 | Comparison 单 Session，关闭原运行进程后仍可从结果独立发起 |
| A5 | 恢复不足保存原因且不生成可执行场景，无强行接受入口 |
| A6 | 重入受控、压缩工具配对完整、输出修复不重复副作用 |
| A7 | 模型输入、工具、压缩与结果可追溯；日志写失败不能宣告成功 |
| A8 | 程序重开可读完整已提交历史，不续跑、不重发、不猜进程消失 |
| A9 | 模型、工具与 Runtime 均响应取消，任务、终止与清理事实分开 |
| A10 | 工具权限按角色注入，源目录保护和数据边界校验保持成立 |
| A11 | 三平台分别验证本机 shell、路径、权限、进程清理与模拟流程 |
| A12 | 旧规范及 ADR 随对应实现更新，不保留第二套 Host 或编排 |
| A13 | 纯 CLI 完成全部 TUI 业务；完整与分步运行共用实现，不加载 TUI |
| A14 | JSON/JSONL、错误分类、退出码和事件续读契约可供脚本稳定使用 |
| A15 | 第二进程取消 CLI/TUI 的三类操作；竞态、过期、不可达不误杀或误改终态 |
| A16 | 独立第三测试 Pack 只增加包与配置，宿主不变即可导入/执行模拟任务并展示；内置 Pack 跑相同契约测试 |
| A17 | 封存场景重复运行指纹一致，移走来源后仍可运行；对照读取封存结果 |
| A18 | 插件导入/运行能力独立，拒绝重复身份及不兼容版本，历史查看不加载插件 |

交互验收由 [TUI 规划](./reprise-tui-design.md#验收)拥有。机械检查不证明 Controller 与原用户语义等价，人工评估记录样例与局限。三平台真实验证缺失时不声明正式支持。
