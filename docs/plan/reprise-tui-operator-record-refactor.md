# TUI 操作者记录面全面重构

面向执行重构的 coding agent。只读本文、当前 `src/tui/` 与文内链接即可开工。信息取舍以[操作者画布](./reprise-tui-operator-canvas.md)为准，按键与阅读合同以[阅读与交互](./reprise-tui-design.md)为准，此刻行协议以[此刻行与已结算画布](../decisions/accepted/2026-09-10-tui-live-now-row.md)为准。恢复、模拟用户与对照短句脊在落地前以[内部 Agent Trace](./reprise-tui-recovery-trace.md)为准，与此刻行记录中「内部 assistant_visible 不进主列」冲突时按该计划实施并另写 ADR。落地操作以[产品 TUI](../product/tui.md)为准，本计划改的是目标页图与投影，不能把目标写成已上线行为。

本机 HTML 草图（`docs/research/reprise-tui-operator-canvas.html`）只演示过程怎么长出来，不受控，不拥有验收，不能当终端证据。

进度记在 [MASTER](../progress/MASTER.md)。开工第一批时把 MASTER 当前批次改成本文对应节；未开工不把本计划标成进行中。

## 目的

操作者在观看一次隔离对照，不是在写代码。整条主路径（封面 → 来源 → 恢复 → 选候选 → 协作 → 结果 → 可选对照 → 重开历史）必须回答同一组问题：任务是什么、此刻谁在干活、有没有卡住、人类在原产品里会看到什么、结束后打开什么。

**进行中只占一条此刻行**（无工具时 `{声部} · working`，有公开进行中换成 `{verb} · {leaf}`），已结算事实按时间追加。空窗解法对恢复、模拟用户、候选、对照通用，不按产品或角色另发明白。

## 必须保持的不变量

- TUI 是事件日志的只读投影，不持有实验状态机，业务操作走现有 Workflow。
- 依赖方向：`tui` → `application`。禁止 TUI 按 `productId` 分支或解析产品私有帧。
- 候选正式正文只来自已校验的 `candidate.user_view_persisted`。进行中只读 `payload.live`（`PublicLiveActivity`）。`assistant_visible` 全文只经 `[o]`。
- 进入模型请求的输入必须能从事件复原。此刻行不是模型输入，不得写入 briefing。
- 折叠只改视图。失败、投递拒绝、权限、恢复终态不得被工具合并吞掉。
- 密钥不进画面明文、事件、artifact。
- 不新增聊天输入框、产品第二窗口、detach、假进度百分比。
- 不把 `intake-tui.ts` 整文件推倒；按投影、页图与输入分批替换。
- Windows 11 是已验证平台；改渲染必须重录并提交触及的 `docs/tui-audit/frames/`。真终端 IME/滚轮/拖选按[平台矩阵](./2026-09-08-platform-evidence-matrix.md)单独关闭。

已生效、本计划复用而不重做的协议：[公开活动单列时间线](../decisions/accepted/2026-09-08-public-activity-timeline.md)、[正式时间线只投影 UserVisibleTurn](../decisions/accepted/2026-09-10-user-visible-turn-timeline.md)、[阅读锚点与搜索](../decisions/accepted/2026-09-08-tui-reading-search-terminal.md)、[选择与配置按键](../decisions/accepted/2026-09-08-tui-selection-and-config-keys.md)、[标准 Runtime 事件](../decisions/accepted/2026-09-09-candidate-runtime-events.md)。

命令目录、来源四层空态、主题框线的改法见[界面重构](./reprise-tui-surface-refactor.md)。**画布、此刻行、页图收口与结果段由本文拥有**；不要和那份计划同一批抢同一组帧。

## 目标页图

用户可见的主路径是一条实验记录，不是一串互清空的卡片。页图枚举以 [`workbench.ts`](../../src/tui/workbench.ts) 的 `WorkbenchPage` 为准；下表写目标行为。

| 操作者看到的面 | 目标 | 允许的独立页 |
|---|---|---|
| 封面 | 新实验 / 历史 / 内部模型 / 语言。`/` 只开应用命令。最近实验一行，Enter 打开该记录末尾。 | `home` |
| 来源四层 | 产品 → 项目 → 会话 → 起点核对。会话 Enter 只进核对，核对 Enter 才冻结。发现失败用计数。 | `sessions`、`inspection`；项目宽屏左列表右详情（阅读规划已规定） |
| 内部模型 | 三个内部角色共用配置；候选目录不出现。 | `config` |
| 历史 | 打开实验即同一套记录投影，定位最后结果，可向上滚全过程。 | `history` 列表；详情不是第二套语义 |
| 恢复 / 候选协作 / 对照过程 | **同一阅读面**：分段标题 + 此刻行 + 已结算组。顶栏：任务、阶段、产品、状态、耗时。恢复阶段不写轮次。 | `running` 为唯一阅读面 |
| 候选产品 / 模型 | 只两页，叠在恢复记录尾。选完模型进入模拟用户，不要确认页。模拟用户页不带恢复色块。 | 可保留独立 `WorkbenchPage`；选择页禁止清掉恢复，运行页重新开始 |
| 结果 | 叠在记录底部：任务判断、技术终止、清理；短标签打开产物；跳过对照写「对照未运行」，`c` 追加对照。 | 禁止用独立结果页替换画布 |
| 失败 / 中断 | 恢复不足、取消中 / 已取消、端点不可达、清理失败各用一句人话。 | `error` 仅无法进入记录时 |
| 深层记录 | 原始事件入口，不是首页导航。 | overlay `viewer` |
| 角色一览 | 退出主路径。 | 不得挡记录 |

手填 `source` 根目录不得从封面命令到达。

## 两层画布（实施口径）

细节与「画什么 / 不画什么」见操作者画布与此刻行 ADR，此处只固定代码必须遵守的口径。

**此刻行（原地替换，钉在列尾）。** 声部前缀：`Recovery` / `Controller` / `Comparison` / `Candidate`。无公开进行中工具：`{声部} · working`。有 `live` 或内部 `tool_called`：同一 `itemId`（`now:{lane}`）换成动词与叶名。SEND / DONE / `user_view_persisted` / `recovery.completed` 后隐藏让位。未带 `live` 的 `tool_started` 不进主列。并发时附「另有 N 项」。超过约 30 秒无新恢复发现：标题可用「仍在恢复」，禁用候选的「等待本轮结束」。

**记录（可滚、可展开）。** 只追加值得回顾的事实：恢复终态与已确认发现、调查组计数、`write` / 失败、投递卡、可见回复、任务 / 终止 / 清理、对照结论。命令、stdout、独白、thinking、`compact tail` 默认不进主列。

**发现短句。** 主列发现必须来自已校验公开事件，禁止从 `assistant_visible` 抽首句。最低过程用此刻行 + 工具组 + `recovery.completed` 终态即可开工。若恢复进行中必须追加「发现」行，同批新增事件并写 ADR，不得在 TUI 里发明。

Pack 动词映射（Claude `tool_use`、Codex `item/started`）已由 Adapter 写入 `runtime.tool_started.live`。本计划不改 Pack API major，不把映射搬进 TUI。

## 现状与目标差异

| 位置 | 当前能力 | 重构目标 |
|---|---|---|
| `src/tui/timeline.ts`、`agent-activity.ts` | 已投影此刻行、`working`、组折叠、失败合并、`live` | 钉列尾、让位、30 秒文案与分段标题收口；禁止把 live 行插进已结算历史中间 |
| `src/tui/pages/run.ts` | 运行页画时间线；仍有准备条、图例、等待文案 | 恢复 / 协作 / 对照共用 chrome；空画布必须有此刻行 |
| `src/tui/workbench.ts` | `compare-gate`、`result`、`actorsOpen`、宽屏 `joinColumns` | `running` 唯一阅读面；结果段叠底；角色 overlay 退出主路径 |
| `src/tui/pages/candidate.ts`、`confirm` | 独立选择页 | 叠在记录尾，不丢恢复正文 |
| `src/tui/pages/result.ts` | 独立结果卡；结果页可在时间线下拼 summary | 三行人话 + OSC 8 短标签成为记录末段 |
| `src/tui/pages/home.ts`、`intake.ts`、`history.ts`、`config.ts` | 斜杠、四层、配置已存在 | 信息层次与页脚键对齐阅读规划；主路径去掉手填 source |
| `src/products/shared/public-live-map.ts` | Pack 写 `live` | 新工具名只扩映射与校验，不改 TUI 分支 |

## 代码入口

界面所有者 [`src/tui/`](../../src/tui/)。页图 [`workbench.ts`](../../src/tui/workbench.ts)；输入 [`controller-input.ts`](../../src/tui/controller-input.ts)、[`page-input.ts`](../../src/tui/page-input.ts)；投影 [`view-projection.ts`](../../src/tui/view-projection.ts)、[`timeline.ts`](../../src/tui/timeline.ts)、[`fold-process.ts`](../../src/tui/fold-process.ts)、[`timeline-read.ts`](../../src/tui/timeline-read.ts)。Pack `live`：[`public-live.ts`](../../src/core/public-live.ts)、[`public-live-map.ts`](../../src/products/shared/public-live-map.ts)。假终端帧：`docs/tui-audit/frames/`。

## 批次

每批可审查、可 `npm run check`。不要并行改页图和主题到无法回滚。每批只重录该批触及的帧。协议、页图或快捷键变化时同批更新 `product/tui.md` 与相关 ADR。

| 批次 | 出口 | 主要改动 | 验证 |
|---|---|---|---|
| R1 记录壳 | 一个实验一条可滚记录 | `running` 为阅读面；对照不再必经换页；结果段叠在时间线底；历史打开同一投影 | `page-input`、`codex-intake-commands`、`local-history`；封面/运行/结果帧 |
| R2 此刻行 | 任何进行中声部主列不空 | chrome 与 30 秒文案；live 行钉尾；组折叠与失败合并不被此刻行打断 | `timeline`、`agent-activity-canvas`、`narrative-canvas`、`public-live-protocol`；运行帧含 `working` / `live` |
| R3 选择不丢记录 | 选候选时仍能滚回恢复 | 产品 / 模型叠在记录尾；模拟用户页清空恢复色块 | 候选选择帧；核对恢复标题仍可见 |
| R4 主路径单列 | 默认阅读不被第二栏或角色层挡住 | 运行面去掉主路径过滤/角色 overlay；Tab/Enter 展开；`viewer` 留深层 | 运行帧无角色层；`actors` 不出现在默认 hints |
| R5 终态 | 判断 / 终止 / 清理 / 短标签 | 结果段文案；OSC 8；失败与中断投影 | `tui-workflow`、结果/失败帧 |
| R6 选择面密度 | 封面与来源符合阅读规划 | 封面命令与最近实验一行；项目详情层次；空态三类；降级手填 source | `product-first-intake`、会话帧（含 CJK） |
| R7 视觉与规范 | 页脚与主题符合目标层次 | `theme` / `widgets` / `i18n`；`product/tui.md` 改为落地行为 | 全套 `tui-audit` 重录；`npm run verify:docs` |

R1 必须先于 R3、R5。R2 可紧挨 R1，但不要和 R7 抢同一批帧。R6 不要和 R7 同批。发现短句若需要新事件，插在 R2 之前单独一批，先 ADR 再生效。

## 每批实施要点

### R1 记录壳

阅读 [`workbench.ts`](../../src/tui/workbench.ts) 的 `WorkbenchPage` 与 `renderBody`。目标：`compare-gate` 不再挡住结果。`c` 从结果段启动对照；对照进行中主列只投影对照 Agent，不带控制 Agent 的 Input 与候选回复。`result` 在 skipped 写未运行，完成后换 headline。历史重开走 `projectPersistedTimeline`。对照仍是独立 Workflow。

反向：默认路径再把对照做成空白门页并丢掉结果框，或对照页再铺 Input 卡，则红。

### R2 此刻行

阅读 [`timeline.ts`](../../src/tui/timeline.ts) 的 `appendTimelineEntries` / `projectInternalNow` / `projectCandidateNow`。目标：`now:*` 只出现在列尾；invocation 开始即 `working`；工具完成后回到 `working` 直到下一刀或让位。运行 chrome 在恢复阶段使用「正在恢复会话」，禁用候选等待句。空时间线且 `runPhase==='recovery'` 时仍画此刻行，不得只写「候选正在写回复」。

反向：`timeline.ts` 出现 `message.content`，或进行中帧既无 `working` 也无 `live` 动词，则红。

### R3 选择不丢记录

候选产品 / 模型可以仍是独立 `WorkbenchPage`，但布局必须带当前任务短句，并允许滚回已投影的恢复段（或把选择做成记录尾 overlay，不得 `innerHTML` 式清屏）。选完模型 Enter 开跑，不要第三页确认。进入模拟用户后主列不投影恢复色块。无 accept 的恢复失败禁止进入隔离候选，原因一句人话。

反向：模型页在 `status` 无 accept 时仍可开跑，则红（沿用已有恢复失败门）。

### R4 主路径单列

运行阅读默认单列。宽屏 `joinColumns` 留给来源项目页（阅读规划要求），不用于把 Controller 工具赶到右栏当主阅读。`actorsOpen` 退出默认 hints 与主路径按键；需要时留在 `?` 或深层。

反向：默认运行帧再出现角色 overlay 标题挡时间线，则红。

### R5 终态

三条可见记录对应 `run.outcome_created` 的任务 / 终止 / 清理。产物用短标签，走已有 OSC 8 规则；终端无超链接时完整可复制路径。不把对照 `headline` 写成任务判断。`token` / `cost` 未采集写 `not recorded`。

反向：默认结果帧把超长盘符当唯一入口且无短标签，则红。

### R6 选择面密度

封面只回答从哪开始。来源列表不展示绝对路径或 transcript。筛选空匹配禁止确认。返回保留光标与筛选。配置页标题固定内部三角色。

反向：封面 `/` 把输入送给 Agent，或筛选空列表仍能 Enter 冻结，则红。

### R7 视觉与规范

底栏只列本页会响应的键。`product/tui.md` 在本批结束后描述落地行为；迁移表 TUI 行只留真终端缺口。本机 HTML 仍不拥有验收。

## 不做

- 不重写 `application/` 实验生命周期、Recovery/Controller/Comparison 的模型合同。
- 不关闭付费模型 lane、Runtime smoke、三 OS 真终端矩阵。
- 不在 TUI 为每个 Pack 做私有帧解析。
- 不把 HTML 外侧「完成阶段」按钮做成产品功能。
- 不把内部 Agent 独白或候选 thinking 当直播正文。

## 完成判据

用户从封面斜杠走到重开历史，始终在同一条实验记录上阅读过程；进行中必有此刻行；结算后此刻行让位给投递卡或可见回复；结果三行人话与短标签可打开。假终端帧审计通过。真终端点击与 IME 不在本计划关闭。

## 风险

- 帧审计会大面积变。每批只更新触及的帧。
- `compare-gate` 与 CLI 默认不挂对照一致，只改 TUI 呈现位置。
- 历史「用例 / 实验」双 Tab：封面不展示冻结核库；实验打开变成连续记录。
- 恢复「发现」若未新增事件，R2 不得用独白冒充发现。
