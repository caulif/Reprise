# Comparison Agent 全面重构方案

本文是 Comparison Agent 唯一的目标架构与实施方案。产品目标以[真实任务比较卡](../decisions/accepted/2026-09-09-comparison-shareable-task-card.md)为准，四轮 prompt 草案以[实施参考](./comparison-task-card-implementation.md)为准，权威在源码。

## 目标

Comparison 完成一次真实任务的反事实比较：理解用户在整个会话中想完成什么，调查历史方案和候选方案的实际交付与过程，生成一份具有传播力的 HTML 比较卡，并在同一 Session 中完成最终审阅。

核心结果只有两个：

- `report.html`：面向人类的真实任务比较卡，传播力来自具体反差和实际交付物；
- 现有薄信封中的 `headline`：HTML 首屏核心发现的一句话版本。

不新增推荐字段、评分协议、场景建议、跨任务排名或 HTML 解析器。一次比较只描述本次任务和执行条件。

## 现有结构的问题

当前 Comparison 把一次完整工作压缩成单个结构化请求：同一个 request 同时承担资料调查、判断、页面创作和输出信封。Agent 因而容易过早写报告、只看摘要、复述日志，或把页面表达当作判断本身。

现有 Host 也主要围绕“调用模型、解析 JSON、修复 JSON”设计，不能自然承接连续的自由工作委托。用户输入、历史回答、候选过程和交付物没有统一的按需资料入口；`briefing` 摘要容易成为 Agent 的事实替代品。

重构不在旧 prompt 上继续堆规则，而是拆开三种职责：Host 管 Session 生命周期和事实边界，Agent 自主调查与创作，发布层只发布最终成功报告。

## 目标架构

```text
ComparisonApplication
  ├─ ComparisonMaterializer
  │    ├─ user-inputs/INDEX.tsv + user turn files
  │    ├─ observations / process indexes
  │    ├─ sealed candidate and historical mounts
  │    └─ facts / links / metrics
  ├─ ComparisonSessionRunner
  │    ├─ one Agent Session
  │    ├─ four ordered work requests
  │    └─ final envelope request
  ├─ AgentSessionHost
  │    ├─ freeform work request
  │    └─ structured result request
  └─ ComparisonPublisher
       ├─ final report validation and atomic publish
       └─ failure / cancellation artifact
```

### 所有权

| 组件 | 负责 | 不负责 |
|---|---|---|
| Materializer | 生成稳定资料树、事实投影、证据目录和输入索引 | 判断哪边更好、制作摘要性结论 |
| Session Host | 一个 Session、模型调用、工具循环、审计、压缩、取消和错误传播 | Comparison 业务阶段、HTML 内容判断 |
| Comparison Runner | 发送四轮委托、维护顺序、只在末轮解析信封 | 绕过 Host 自己实现模型 loop |
| Comparison Agent | 调查、判断、选择实物、写作和审阅 | 修改候选交付、修改运行状态、猜测缺失事实 |
| Publisher | 最终报告读取、原子发布、失败隔离 | 重写 HTML、检查固定章节、从 HTML 提取推荐 |

## 一次比较的生命周期

1. 应用为 attempt 创建目录和资料树。
2. Materializer 写入完整用户输入索引、事实、链接、观察文件和只读挂载。
3. 应用写入 `comparison.requested`，其摘要覆盖实际启动材料和资料文件摘要。
4. Runner 创建一个 Session，并发送四条有序 user prompt。
5. 前三轮是自由工作委托；Agent 可以读、分析、写草稿和继续调查。
6. 第四轮审阅 `report.html`，然后按现有信封契约返回 JSON。
7. Host 校验 schema、证据归属和报告可读性。
8. 只有第四轮成功且报告存在时，Publisher 才把报告原子发布到实验根。
9. 任意轮次失败、取消或最终校验失败，都不发布中间报告，不覆盖旧成功报告，并写失败页。
10. 释放 Session；独立 persisted comparison 复用同一生命周期，不依赖原运行进程。

不设置 Comparison 专属总预算、每轮配额或请求截止。取消、进程错误、传输错误和外部生命周期关闭仍然有效；无 deadline 必须由通用 Host 明确表达，不能靠删除 prompt 中的“预算”字样伪装实现。

## 资料与上下文架构

### 启动资料

启动消息只提供短委托和稳定路径，不把双方过程全文塞进上下文。第一轮必须从：

```text
observations/user-inputs/INDEX.tsv
```

按顺序读取全部用户输入文件。索引至少记录稳定 turn ID、顺序、角色、来源、正文路径、附件入口和关联产物入口。历史真人输入与候选 Controller 输入必须可区分。

用户完整会话是任务标准。不能只读取第一条输入，也不把后续输入硬分成“澄清”或“新增”。历史 Agent 输出、工具过程、候选响应、交付物和媒体按需读取。`briefing/INDEX.md` 只负责导航，`facts/context.json` 只提供 Host 事实投影，不能替代原始证据。

### 按需读取

资料索引必须回答“是什么、在哪里、属于谁、对应哪一轮、如何继续读取”。Agent 根据当前判断选择下一份材料；不建立额外检索系统，不预先由 Host 筛选所谓重要事件。

上下文压缩保留用户输入入口、已确认需求、关键发现、草稿位置和可复读证据路径。长正文可以丢出上下文，但不能丢失唯一入口。进入模型的新增输入必须仍可由事件日志复原。

### 事实与媒体

时间、token、速度、费用等硬指标由 Host 从已采集事实投影。缺失、部分采集和不可比保持区别；不补零、不猜价格、不用总任务时长冒充生成速度。媒体传递和视觉能力由 provider 与通用 Agent 层负责，Comparison 不按模型品牌分支。Agent 只能描述实际观察到的媒体内容。

## Session Host API

通用 Host 需要明确区分两种请求，而不是让所有字段可选后语义模糊：

```ts
type FreeformWorkRequest = {
  promptContent: string;
  signal?: AbortSignal;
};

type StructuredWorkRequest<T> = {
  promptContent: string;
  schema: TSchema;
  outputContract: string;
  maxRepairAttempts: number;
  normalize?: (value: unknown) => unknown;
  validate?: (value: T) => string | undefined;
  signal?: AbortSignal;
};
```

两者共用同一个 Session、工具注册、审计、压缩、取消和错误传播。Freeform request 在模型完成当前 append 后返回，不解码 JSON、不触发 schema repair；Structured request 才执行现有 decode、normalize、validate 和 repair。Comparison Runner 不直接调用 model caller，不复制工具循环。

Host 必须记录每次委托的 prompt、顺序、Session ID、模型请求、工具调用、返回状态和错误。前三轮自然语言可复原；第四轮的信封和修复也可复原。Freeform 不是“无记录的聊天”。

## 四轮 Runner

Runner 是唯一知道四轮顺序的 Comparison 组件。它不把四轮暴露成四次应用级 `compare()`，也不在中间解析业务结果。

| 轮次 | 目标 | 结果处理 |
|---|---|---|
| 1 | 读取全部用户输入并形成任务理解 | 保留 Session 上下文，不能评价或写最终报告 |
| 2 | 调查双方实际表现并自由准备 | 可写草稿、笔记、素材或其他准备，不发布 |
| 3 | 创作或重组 `report.html` | 可继续读取材料，写入 attempt 报告 |
| 4 | 审阅页面并交付 | Structured request，返回现有薄信封 |

四轮 prompt 的具体文字来自实施参考。System prompt 只保留职责、事实纪律、隐私/离线边界和连续 Session 说明；不放预设结论，不叫产品角色名，不要求固定评分和固定章节。

如果任意 Freeform request 失败，Runner 立即停止；如果第四轮 schema repair 失败，整个 attempt 失败。中间自然语言不转换成新 schema、不持久化成业务状态。

## 报告与资源发布

Agent 自由选择首屏、版式、交付物、过程片段和交互。必须以实际反差和实物表达，不能伪造截图或把抽象能力判断当作证据。硬指标应在容易找到的位置展示，但不建立“证据与口径”独立区块。

报告可以在第二轮草拟，但发布器只认第四轮成功后的 `report.html`。如果页面引用 attempt 临时文件，发布后必须仍可访问：优先内嵌可分享实物，原始证据链接使用稳定发布路径；不为视觉效果自动引入资源平台。

Publisher 不检查 HTML 章节、组件、颜色或推荐文案，不从 HTML 读取 recommendation。它只检查现有报告文件、信封 schema、证据归属和发布原子性。

## 代码改造范围

### 同步修改边界

这次重构需要同步修改 Comparison 的上下游契约，但不扩展为全项目重写。必需同步的模块是：

- **Agent Session Host**：增加自由文本工作委托，继续共用工具循环、审计、压缩、取消和错误传播；Controller、Recovery 的结构化请求保持原语义。
- **Briefing 与观察树**：物化完整用户输入索引，提供历史回答、候选过程、交付物和媒体的稳定按需入口。
- **事实投影与 schema**：只补齐能够从已持久化事实确定性得到的时间、token、速度和费用字段；缺失、不适用和不可比保持区分。
- **应用编排与发布**：运行结束后的比较与 persisted comparison 共用同一个四轮 Runner；只有第四轮成功才发布报告，中间草稿和失败不能覆盖旧报告。
- **审计与事件复原**：四轮委托、工具调用、压缩、草稿写入和最终信封都能从已持久化事实追溯；用户输入索引可由历史事实稳定生成。
- **测试与 prompt 快照**：同步重写 Comparison 阶段、Session 生命周期、观察文件、报告发布和 prompt snapshot 测试。
- **文档与进度**：生效后同步 Comparison 架构、角色与 prompt 入口、单 Session 决策及 MASTER 进度。

不应因为本次重构修改 Controller 的判断协议、Recovery 的调查协议、CandidateRun 状态机、Product Pack、TUI 状态机或 provider 的多模态分支。TUI 只确认最终报告、失败页和 headline 的导航，不解析 HTML，也不新增 recommendation 字段。不要为了 Comparison 自建 Agent loop 或重写全局遥测系统。

同步顺序固定为：Session Host 自由委托 → 用户输入索引与资料树 → Comparison 四轮 Runner → 事实投影与发布 → persisted 入口和 TUI 导航核对 → 文档与完整验证。

### 删除或重写

- 重写 `src/agents/comparison-agent.ts` 的单次请求编排、旧 system prompt、单轮 output contract 和与产品目标冲突的“不选赢家”表述。
- 重写 `src/application/comparison-briefing.ts` 的启动导航，加入用户输入资料树和稳定关联入口。
- 重写 `src/application/experiment-report.ts` 中 Comparison 的调用与发布边界，仅末轮成功发布。
- 重写 Comparison 阶段测试，不再用“两次 compare 调用”模拟同一 Session 的连续工作。
- 核对并删除只服务于旧单轮编排的测试夹具、prompt snapshot 和调用方分支；没有证据证明过时的代码不保留兼容壳。

### 扩展

- 扩展 `src/infrastructure/agent/host.ts`，加入 FreeformWorkRequest；保持 Controller/Recovery 结构化路径不变。
- 扩展 `src/products/history/observations-materializer.ts`，物化用户输入索引并保持 privacy/ownership 边界。
- 按事实证据最小扩展 `src/application/comparison.ts` 和 `src/core/comparison-schema.ts` 的指标投影。
- 核对 `src/application/harness-agents.ts` 的 Comparison 无 deadline 装配，不影响其他角色。

### 保留

- 一个 attempt 一个 Session、取消、压缩、证据白名单、七工具、只读 candidate、失败页和旧报告不覆盖语义。
- `ComparisonResultSchema` 的薄信封；主结论不进入新字段。
- `experiment-compare-persisted.ts` 的独立入口，但改为调用同一 Runner。
- TUI 的结果导航和状态投影；仅在路径或 headline 契约确实改变时同步修改，不让 TUI 承担 Comparison 判断。

## 测试与验收

### 确定性测试

- Host：Freeform request 完成且无 JSON repair；Structured request 原有行为不变。
- Runner：一次 compare 创建一个 Session、顺序发送四轮；前三轮散文，第四轮合法信封。
- Runner：第二轮写报告草稿，第三/四轮能读写同一工作区；中间报告不发布。
- Runner：任意轮取消或失败停止后续轮、释放 Session、保留旧成功报告。
- Observation：用户输入索引稳定排序，全部用户 turn 可读，角色和附件入口正确。
- Facts：缺失 usage、速度、费用时不补零；同一 facts 构建函数供正常与独立对照复用。
- Publish：仅第四轮成功发布；引用资源发布后仍可用。
- Audit：四轮 prompt、工具调用、压缩和最终信封可复原。

### 人工验收

使用真实或显式 opt-in 的案例检查：结果正确但过程费劲、页面漂亮但核心失败、两边接近、历史产物缺失和视觉交付物。检查比较卡是否展示具体反差和实物、是否理解完整用户需求、是否把执行条件误写成能力差异。

不把审美、模型主观判断或传播效果写成固定门禁。不创建通用 LLM 评测平台。

## 实施顺序

1. 先追踪当前调用链和 Host Session 实现，冻结不变量与测试夹具。
2. 实现并验证 FreeformWorkRequest，不改 Comparison prompt。
3. 物化用户输入索引和导航，验证完整会话可按需读取。
4. 替换 Comparison system 与四轮 prompt，接入单 Runner。
5. 核对无 deadline 装配和取消生命周期。
6. 用确定性事实补齐页面所需的真实指标，禁止猜值。
7. 核对草稿、资源、失败页和独立对照发布边界。
8. 最后同步 architecture、prompt 入口、accepted decision、MASTER，并运行构建和项目门禁。

每一步都先保留可运行的最小路径；不为未来多候选、跨任务聚合或分享服务提前设计接口。

## 风险与回滚

- Host 自由文本扩展影响其他角色：用独立 request 类型和 Controller/Recovery 回归测试隔离。
- 用户输入索引重复或泄露：优先引用已有正文，沿 privacy policy 做 fixture 检查，失败时停止发布。
- 四轮 Session 超时或取消：通过统一 Host deadline/AbortSignal 语义处理，不用 prompt 自救。
- 草稿引用临时路径：发布测试验证链接，失败时阻止成功发布。
- Prompt 过度规范化：真实案例检查 Agent 是否仍能自由选材和布局；删除不能证明价值的规则。

## 实施证据

代码修改完成前不在本节声称通过。完成后记录实际命令、测试结果和未覆盖边界；文档门禁不能替代运行验证。进度证据写入 [`docs/progress/MASTER.md`](../progress/MASTER.md)，不在本文打勾。
