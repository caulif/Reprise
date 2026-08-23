# Controller 模块架构分析与优化建议

> 更新时间：2026-08-20  
> 本文基于 Controller 相关产品文档、架构文档、实验编排、Agent Host、CandidateRun、观察工具和 TUI 代码整理。  
> 目标不是重新设计 Controller，而是找出影响正确性、可恢复性和 Agent 发挥的少数关键问题。

## 1. 先定义问题

Controller 的本质不是“自动操作员”，也不是“评分器”，而是：

> 在 Candidate 完成一轮工作后，根据用户原始目标、当前可见事实和候选轨迹，决定是否以及如何继续与 Candidate 协作。

它只有两个有效动作：

```text
send(message) | done(reason)
```

因此 Controller 的价值取决于三件事：

1. 它是否看到了足够且真实的事实；
2. 它是否拥有足够大的判断和表达空间；
3. 它的决定是否经过可靠的执行和记录。

优化应围绕这三点展开，而不是增加更多抽象、规则或自动判断。

## 2. 当前架构概览

当前调用链基本合理：

```text
TaskCase
  → CandidateRun 到达 awaiting_controller
  → inspectRun 生成当前观察
  → 组装 SteeringContext
  → ControllerAgent / Pi Agent Host
  → 结构化 ControllerDecision
  → CandidateRun.submit / settleController
  → 继续 Target 或结束实验
```

职责大致分明：

- `ControllerAgent`：定义 Controller 的模型边界、Prompt、输出协议和 session；
- `experiment.ts`：编排观察、调用、预算、事件和下一步动作；
- `CandidateRun`：掌握运行状态、消息投递和最终结果；
- `inspectRun` 与 observation tools：提供 Host 事实；
- TUI：展示运行过程和接收用户命令。

这套结构不需要推翻，也不需要引入事件总线、工作流框架或新的 Controller 层级。

## 3. 当前已经正确的设计

### 3.1 Controller 与 Target 职责分离

Controller 不直接执行任务，不调用 Target 工具，也不修改 workspace。它只发送普通用户消息或结束。这是实验公平性和安全性的基础，应保持不变。

### 3.2 决定是结构化结果

`send` / `done`、intent、reason 和 evidence refs 已经形成了明确协议。模型失败、超时、取消与正常决定也已经区分，避免把协议错误当成实验结论。

### 3.3 CandidateRun 是状态真相

发送、结束、失败和取消最终都经过 `CandidateRun`，而不是由模型或 TUI 直接改变状态。这一点应继续保持。

### 3.4 Agent 有按需观察能力

Controller 不是只看一段静态摘要，也可以通过 observation tools 分页读取历史 transcript、当前 run events 和 artifacts。这比把所有材料强行塞进 Prompt 更合理，也更能发挥 Agent 的判断能力。

### 3.5 已有必要的安全阀

调用次数、墙钟、重复消息、超时、隐私限制和 session 生命周期控制已经存在。下一步不应继续堆叠限制，而应先确认这些限制是否表达清楚、是否可恢复。

## 4. 最关键的问题

### P0：模型实际看到的输入无法完整复原

这是当前最重要的架构缺口。

Controller 请求前，系统会重新读取：

- 当前事件日志；
- 当前 workspace fingerprint；
- 当前生成的摘要；
- 当前可用的 observation tools；
- 进程内持续存在的 Controller session。

但事件日志主要记录了 `controller.started` 和 `controller.decision`，没有记录本轮请求实际使用的 `SteeringContext`、观察快照、工具读取结果或输入摘要。

这会导致：

- 进程崩溃后无法确定 Controller 当时看到了什么；
- 事后重新读取 workspace 可能得到不同结果；
- 无法严格审计某个 evidence ref 是否确实对模型可见；
- Controller 的 session 连续性依赖内存，而不是可恢复事实。

这不是要限制 Agent，而是要保证 Agent 的自由判断建立在可追溯事实之上。

#### 最小改进

每次 Controller 请求前，记录一个请求事实，例如 `controller.requested`，包含：

- `requestId`、`runId`；
- 本轮观察快照或其 artifact ref；
- 输入 schema/version；
- evidence refs 及来源；
- 当前预算；
- 工具集合版本；
- 脱敏后的输入 digest。

模型拥有的自由度不变，但系统能够回答：

> 这一轮 Controller 究竟看到了什么？

不要求保存模型凭据，也不应因为审计而无条件保存受隐私策略禁止的模型文本。

### P1：evidence ref 的来源需要统一

当前 Controller 校验的 evidence refs 主要来自 `current` 和 `trajectory`，但 Prompt 又允许模型先通过 `read_observation` 获取新观察，再引用新 ref。两者需要明确统一的生命周期。

最小改进是引入本轮请求范围内的 evidence catalog：

- 初始观察登记已有 refs；
- 工具成功返回的新观察登记新 refs；
- 最终决定只能引用本轮 catalog 中属于当前 run 的 refs。

这不是增加 Agent 规则，而是防止引用不存在或跨 run 的事实。

### P1：模型输出的消息边界还不够明确

当前 `message` 只要求非空。作为外部模型输出，至少需要：

- 拒绝纯空白；
- 设置合理的最大字节数；
- 拒绝异常控制字符；
- 在进入 Target Runner 前完成校验。

不建议现在加入语义分类、自动改写或复杂的内容过滤。消息应该尽可能原样交给 Target；系统只做防止协议破坏所必需的检查。

### P1：取消和重复调用需要请求级保护

当前取消主要依赖 session cancel，ControllerAgent 也没有明确的同一 run 单飞约束。需要保证：

- 同一个 run 同时最多一个 Controller 请求；
- 取消后迟到的模型结果不能再次提交；
- 迟到结果有 requestId 可判定并被丢弃；
- 不把模型迟到误认为 CandidateRun 状态变化。

这是并发正确性问题，不是要限制模型能力。

## 5. 暂时不要做的事情

以下方向目前都不是必要问题：

- 不要先拆成多个 Controller Agent；
- 不要引入通用事件总线或工作流框架；
- 不要加入语义相似度来判断“无进展”；
- 不要让应用层替模型判断什么是“正确的下一句话”；
- 不要把 Controller 变成评分器或任务执行器；
- 不要为了重构而大规模拆分 TUI；
- 不要把完整 Prompt、凭据或敏感模型输出写入事件日志。

精确重复消息检测可以保留。它的作用只是防止明显死循环，不应被包装成智能的进展判断。

## 6. 推荐的最小目标架构

```text
Host 生成观察快照
        ↓
记录 controller.requested + evidence catalog
        ↓
Controller 自由读取允许的观察并作决定
        ↓
校验结构和 evidence refs
        ↓
记录 controller.decision
        ↓
CandidateRun 执行 send / done
```

其中：

- Host 负责事实来源和边界；
- Agent 负责理解、判断和表达；
- CandidateRun 负责执行状态变化；
- 事件日志负责恢复和审计；
- TUI 只负责展示和发出命令。

这比增加更多策略更重要：**不要限制 Agent 的判断，只保证它接收到的事实真实、可追溯，决定执行时安全、可恢复。**

## 7. 后续实施顺序

### 第一阶段：只补可恢复事实

1. 增加 `controller.requested` 事件；
2. 保存本轮观察快照及 digest；
3. 将工具产生的观察纳入 evidence catalog；
4. 增加一个离线函数，根据事件和 artifacts 重建请求输入；
5. 添加测试验证重建结果稳定。

### 第二阶段：补必要边界

1. 统一 evidence ref 校验；
2. 增加消息最小边界校验；
3. 增加 requestId、单飞和取消后的迟到结果保护；
4. 保持现有 `CandidateRun` 状态机和 send/done 协议不变。

### 第三阶段：用事实决定是否继续优化

先观察真实运行数据，再决定是否需要调整：

- 摘要内容；
- 工具分页；
- Prompt；
- 重复消息策略；
- TUI 与 application 的进一步拆分。

没有数据证明必要之前，不增加更复杂的规则。

## 8. 验收标准

- 每次 Controller 请求都有可追溯的 request id 和输入 digest；
- 只使用事件日志和已保存 artifacts，可以重建脱敏后的请求输入；
- Controller 可以引用本轮工具新产生的合法 evidence ref；
- 跨 run 或不存在的 evidence ref 会被拒绝；
- 纯空白、超长或非法控制字符消息不会进入 Target Runner；
- 取消后的迟到结果不会改变 CandidateRun 状态；
- 状态变化仍全部经过 `CandidateRun` 和状态机；
- 现有 send/done 语义、Agent 观察能力和真实 Runtime opt-in 行为不被削弱。

## 9. 最终建议

Controller 当前不需要“大改”。建议下一轮只做一个最小纵切片：

> 在不改变 Agent Prompt、模型选择和决策协议的前提下，补齐 `controller.requested`、观察快照、evidence catalog 和离线重建测试。

完成这一步后，再根据实际失败样本决定是否继续调整。这样既能满足持久化和审计要求，也不会过早限制 Agent 的能力或把系统复杂化。
