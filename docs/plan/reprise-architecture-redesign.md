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

1. 读取内部模型配置，选择来源会话、候选 Product Pack 和候选模型。
2. 预检查本机工具、权限、模型能力与显式计费准入。
3. 导入并冻结 TaskCase，准备场景；证据不足则结束。
4. 从封存场景创建候选副本，启动 CandidateRun 和 Controller Session。
5. Controller 形成 opening；harness 先持久化决定，再投递候选。
6. 在公开 settlement 边界保存候选事实；Controller 在同一 Session 决定 send 或 done。
7. 收尾 Runtime、目录和会话，保存结果与清理事实。
8. 用户打开产物或从当前/历史 run 独立发起 Comparison。

Agent 执行机制管理 Invocation 状态。CandidateRun 管理准备、启动、等待候选、等待 Controller、收尾和完成，状态转换继续通过唯一 `assertTransition` 入口。冻结、列表查询和独立对照是普通函数和明确结果，不为了形式建立状态机。

任务判断、终止原因与清理结果保持正交。投递 `unknown` 不自动重发；进程崩溃后展示 interrupted/unknown，不猜测子进程状态，也不自动恢复。

## CLI、TUI 与本机控制

CLI 与 TUI 使用同一 Workflow，功能对等。CLI 应覆盖配置、认证、产品/模型/会话查询、`prepare`、`run --scenario`、完整 `run`、历史、事件、`cancel`、`compare` 和产物打开。机器输出使用版本化 `--json` 或 `--jsonl`，stdout 不混入日志。

活动 CLI/TUI 进程是实验唯一写者。另一终端发送取消请求时，Windows 使用受限命名管道，macOS/Linux 使用私有目录中的 Unix socket；取消请求验证版本、长度、活动所有者与本机认证材料。它不是公网服务，也不允许未鉴权 TCP 回退。

TUI 只投影事件日志和活动事实，不持有实验状态机或生成隐藏推理。详细页面与键盘交互见 [TUI 设计](./reprise-tui-design.md)。

## 持久化与兼容性

持久化记录实验、Session、Invocation、消息、附件、工具事实、压缩、取消、运行结果和 Comparison attempt。外部 JSON、模型输出和磁盘记录都在边界做 schema 校验。秘密不进入事件、artifact、报告或模型上下文。

内部模型 provider 由 Pi/`pi-ai` 管理；候选 coding agent 由 Product Pack 管理。两条兼容路径分开。Pack 是显式配置的可信本地代码，提供版本化窄契约和能力声明；查看旧实验不需要执行原 Pack。

## 七批迁移

1. 执行机制与持久化：建立唯一 Session/Invocation 事实源，收薄现有 Pi Host。
2. harness、场景与工具：迁移 Recovery、场景准备与 CandidateRun 状态所有权。
3. Controller：迁移为每 run 一个连续 Session，取消独立 Understanding 和强制 briefing。
4. Comparison：迁移为每 attempt 一个连续 Session，取消 Planner/Reporter 双会话。
5. Workflow 与 UI：实现对等 CLI/TUI、历史查看、独立对照和只读运行页。
6. 平台与 Pack：实现 PowerShell/Bash、本机 IPC、进程取消和 Windows/macOS/Linux 契约验证。
7. 文档收口：同步当前规范、ADR、导航、TUI 基线和过时材料迁移。

## 验收

迁移完成时必须能够证明：三个角色各有连续 Session；完整过程在重开后可查看但不会自动执行恢复；取消覆盖模型、工具与候选 Runtime；压缩后的模型输入可由事件复原；恢复证据不足不会启动候选；Controller 不使用独立理解调用；Comparison 不使用双会话；CLI/TUI 操作对等；对照可独立发起；Windows/macOS/Linux 各自完成本机任务；旧实验不依赖插件加载；当前规范、ADR 与测试证据不再与本计划冲突。
