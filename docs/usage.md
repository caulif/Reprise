# 使用 Reprise

Reprise 是本地优先的任务比较工具：它从已安装 AI 工具的历史对话准备任务文件，在隔离工作副本中重建任务起点，再由所选工具重做任务。Reprise 使用的模型负责准备、引导和比较；执行模型由所选工具的目录提供。结果用于当前任务的个人判断，不是公共榜单、标准 benchmark 或质量保证。

## 开始

### 内部模型图片能力

openai-compatible 模型可通过 `reprise config set --image-input` 声明图片输入（其他必需配置参数沿用 config set）；声明只控制发送原生块，不创造网关能力。Case `privacy.allowBinary` 仍须授权，已有 text-only Case 不因模型开关自动获得二进制发送权限。Comparison 的受控渲染/预览可请求 `includeImages=true`，拒绝交付时继续文本证据并说明限制。

`reprise config image-status` 离线显示图片探测状态。明确授权付费探测后，在 PowerShell 运行 `$env:REPRISE_RUN_IMAGE_PROBE='1'`，再运行 `reprise config test-image`。命令只发送一张随机条纹 PNG，一次调用且无重试；答案仅由 Host 核对。结果保存于数据目录的 `harness-image-probe.json`，配置指纹改变则显示 stale。passed 只表示当次简单探测通过（随机猜中仍有可能），不保证真实任务、动画或其他媒体能力。普通连接检查仍是文本检查，默认不自动探测图片。

安装与构建步骤见[中文 README](../README.zh-CN.md#快速开始)。摘要如下：

```powershell
git clone https://github.com/caulif/Reprise.git
cd Reprise
npm ci
npm run build
node dist/src/cli/main.js
```

需要 Node.js **22.19** 或更高版本（以 [package.json](../package.json) 为准）。`--data-dir` 指定本机数据目录，默认是当前目录下的 `.reprise`；`--locale zh` 或 `--locale en` 保存操作者界面语言。

下文中的 `reprise` 指 `node dist/src/cli/main.js`（或等价构建产物），**不是** npm 上的裸名包 `reprise`。若已将本项目注册为全局 CLI，命令名相同。

## TUI 路径

1. 在首页选择“重做任务”，依次选择来源工具、项目和历史对话。核对页显示要重做的任务与后续补充；只有在这里按 `Enter` 才开始准备任务文件。原始对话不会被重新执行。
2. 准备完成后选择执行工具。按 `Esc` 可回看准备结论和全部已知限制，再返回工具列表，不会重新准备。准备受阻时无法绕过检查启动执行。
3. 选择工具使用的模型。长模型标识显示在当前选中项详情；`Enter` 验证选择并进入启动确认，不会执行任务。确认页显示任务、工具、所选模型、已准备副本和限制；`Enter` 才开始执行。启动前若验证得到不同模型，页面会显示变化并要求再次确认。
4. 执行页是事件日志的只读投影，默认跟随最新活动；运行中按 `Ctrl+C` 请求停止当前阶段。页脚只显示主要操作，按 `?` 可查看查找、展开等阅读快捷键。浏览、展开和返回页面不会向执行工具发送新消息。
5. 结果页的主动作是“与原结果比较”和“打开本次执行路径”，比较结束后第一项改为报告或失败诊断入口。方向键选择、`Enter` 或鼠标点击激活；比较选择会直接开始模型调用。`p` 查看执行过程，`d` 展开技术详情，`Esc` 结束查看。执行路径不存在时页面会显示不可用原因，打开器接受请求并不保证资源管理器窗口已经展示。

历史对话列表支持方向键、可打印文本筛选、`Ctrl+F` 切换可运行过滤、`Ctrl+N` 加载下一页、`Ctrl+R` 从第一页刷新。核对页没有上下选择项；展开详情后，长核对、准备回看、启动确认和结果详情仍可用方向键或 PageUp/PageDown 阅读，翻页键列在 `?` 帮助中而不常驻页脚。首页“运行记录”可凭任务标题和状态寻找旧运行。设置页用方向键选择字段，`Enter` 行内编辑或切换，低频字段在“更多设置”；`Ctrl+T` 测试连接，`Ctrl+S` 显式保存，离开未保存草稿时默认继续编辑。

## CLI

无子命令进入 TUI；脚本和自动化可使用 JSON/JSONL 的无头命令：

```text
reprise prepare (--source-root <dir> --task-case <file.json> | --source-product <id> --source-path <path>)
reprise run (--source-root <dir> --task-case <file.json> | --scenario <experimentId>) [--product <id> --model <id>]
reprise compare (--experiment <id> | --source-root <dir> --task-case <file.json>)
reprise recover-comparison --experiment <id> --attempt <id> [--publish --status <completed|insufficient_evidence>]
reprise products|models|projects|sessions|inspect|import|history|events|auth
reprise config get|set
reprise cancel <operationId|experimentId|runId>
```

`--product` 与 `--model` 必须成对提供。`prepare` 只准备和封存，不接受候选选择；`run` 从封存场景或 TaskCase 启动候选；`compare` 对已保存运行生成对照。不要把 API 密钥放进命令行参数；`--json` 与 `--jsonl` 互斥。

`compare` 有两种输入模式：

- `--experiment <id>`（可选 `--run <runId>`）— 对**已有**实验目录中的封存运行生成对照；`experimentId` 来自先前 `prepare`/`run` 的输出或 `dataDir` 下的实验目录名。
- `--source-root` + `--task-case` — 从指定 TaskCase 文件启动新的对照流程，不依赖已保存的 experiment ID。

### 无费用查询示例

列出当前机器可识别的来源／候选产品（不调用模型）：

```powershell
node dist/src/cli/main.js products --json
```

输出包含 `productId`（如 `codex`、`claude-code`）和 `roles`。后续 `sessions`、`projects` 等命令需要 `--product <id>`；具体参数以 `reprise <command> --help` 为准。

### 可能计费的操作示例

对已完成的实验生成对照（会调用 Harness 内部模型）：

```powershell
node dist/src/cli/main.js compare --experiment <experimentId> --json
```

`experimentId` 来自该次 `run` 或 TUI 流程写入 `dataDir` 的实验目录。成功时 JSON 包含报告路径；失败时保留事件日志供排障。连接测试（TUI `/config` 的 `Ctrl+T`）同样会发出最小模型请求，可能计费。

报告首先展示任务、双方身份、短结论、时间与估算费用，Token 明细和长方法按需展开。推荐只针对本次运行，可以有条件、结果相近或无法判断；不同 Runtime、工具环境和历史缺口会限制模型能力归因。估算不是实账，也不包含工具费用；未知记录不是零。

报告中的精确引文由 Host 标记为“完整原文”或“节选”，并在发布和离线恢复时再次核对来源与范围。该标签证明引文对应来源，不认证 Agent 在引文之外的解释或结论；旧报告不自动补发标签。

默认 Comparison 调查软预算为 12 次模型请求、30 次工具、120 秒；整体硬上限为 40 次模型请求、120 次工具、10 分钟，金额上限默认不启用。集成调用方通过 `AgentBudget.comparisonResources` 完整替换默认值，传 `{}` 可关闭；长复杂任务须显式调高。普通 CLI/TUI 尚无独立预算设置入口。达到调查软预算时保留重要未知并继续创作审阅；硬保护或取消保留旧报告。启用金额保护而 usage/价格不可用时停止继续调用；在途计费不能精确封顶。真实评估入口与授权见[开发与验证](./development.md#comparison-产品质量评估)。

`recover-comparison` 对旧失败 attempt 默认只读：核对冻结事实、catalog 修订、草稿 digest、成功预览事件和当前发布校验，返回可恢复状态，不调用模型。只有显式加 `--publish --status ...` 才尝试发布，状态必须由操作者依据旧草稿判断；已有根报告时拒绝覆盖。恢复会追加 `comparison.recovered` 事件并更新根 `comparison.json`，原 attempt 日志和草稿不改写。新流程不需要这个命令来处理末尾空文本。

## Reprise 模型设置

配置页（首页“Reprise 模型设置”或输入 `/config`）保存一份供任务准备、执行引导和结果比较共用的 Reprise 模型。配置写入 Git 忽略的 `{dataDir}/harness-model.json`（默认即 `.reprise/harness-model.json`），也可将密钥写成 `env:NAME` 引用。密钥值不会写入事件、artifact 或报告。

自定义模型的图片输入默认未声明，因此内部 Agent 仅接收文本；配置页会显示“未声明，仅文本”，启用后显示“已声明（未探测）”。这项声明影响 Recovery、Controller 与 Comparison，不代表供应商网关已通过图片请求验证，也不由候选 Runtime 的图片能力继承。Comparison 时间线显示实际 Session 的输入类型；仅文本 Session 的视觉质量不能据源码或像素脚本自称目视验证。

### 第三方 OpenAI-compatible 服务（推荐入口）

1. 打开 TUI，输入 `/config`。
2. 选择 **openai-compatible** 类型。
3. 填写服务的 **base URL**、**model ID**（使用服务文档中的实际标识，不要手写会过期的推荐列表）和 **API 密钥**。
4. 选择服务真实支持的 **API 协议**：`openai-completions` 或 `openai-responses`。协议必须与服务匹配；服务自称「兼容 OpenAI」不保证两种协议都可用。
5. 按服务能力开启 **reasoning**（推理强度）和 **图片输入**（`inputCapabilities`）。图片能力默认仅 text；只有模型和服务支持时才启用 image，它控制是否向模型发送原生图片块，不保证能理解所有 artifact。
6. `Ctrl+S` 保存，`Ctrl+T` 可选连接测试（可能产生服务费用）。

### 官方 Pi catalog（高级路径）

官方目录登录**不在 Reprise 内**完成。需先安装 [Pi](https://github.com/badlogic/pi-mono) CLI，在 Pi 交互环境中执行 `/login`，凭据由 Pi 的 `auth.json` 保存。回到 Reprise 的 `/config`，选择 **pi-catalog** 类型并挑选对应目录项。Reprise 不读取或保存 Codex CLI、Claude Code 的登录文件。

候选 Runtime 继续使用用户在目标产品中的登录态；Reprise 不替用户切换全局模型配置。

真实验证脚本要求显式 opt-in；默认开发检查使用本地 fixture。TUI 的恢复、候选运行和对照是用户主动触发的实际任务，同样可能计费。

## 数据去向

实验记录和工作副本保存在本机（`--data-dir` 指定的目录，默认 `.reprise`）。其中包含事件日志、TaskCase、隔离工作区、trace、报告和本地配置。

Recovery、Controller、Comparison 会将完成任务所需的历史内容、工作区观察和工具结果发送到配置的 Harness 模型服务；候选 Runtime 的数据处理由目标产品及其登录态决定，Reprise 不统一代理。进入模型的正文先经过秘密过滤再持久化并发送（见 [`model-input.ts`](../src/infrastructure/agent/model-input.ts)），但过滤不等于会话隐私清洗，也不保证清除全部个人信息或业务内容。

分享报告、trace 或隔离副本前，检查正文、截图、路径和交付物是否含有不应公开的信息。

## 边界

候选在隔离副本运行，源目录受写保护；网络、外部服务和其他路径不会被 Reprise 统一沙箱化。无法安全重放的数据库、部署、支付或网页副作用应使用测试账号、mock、只读观察或取消。历史 Runtime 只是证据，候选使用当前机器可解析的 Runtime；无法观察的配置记录为未知。运行输出不同于历史结果是正常情况，比较报告提供证据而不是统一分数。

报告、trace 和隔离副本是本机文件。不要把含有密钥、会话正文或私有路径的产物提交到 Git。

## 当前试用限制

- **早期准备失败**仍可能发生在 attempt 持久化之前，无法从 attempt 列表解释；见[已知实现问题](./roadmap.md#已知实现问题)。同一 Experiment 的不同 run 已用离线 fake Runtime 验证可从同一封存起点运行；真实 Runtime 的重复运行仍需显式 opt-in 验收。

不要把离线验证当作真实 Runtime 的完成证据。

## 故障排查

| 现象 | 处理 |
|---|---|
| 裸 `reprise` 找不到命令 | 使用 `node dist/src/cli/main.js`；若命令不存在，先 `npm run build` 确认 `dist/` 已生成。未全局安装时裸 `reprise` 不可用是预期行为。 |
| 来源产品或会话列表为空 | 确认目标产品已安装且本机确有历史记录。`products` 只列出可识别产品；`sessions` 需要 `--product <id>`。发现（discovery）与导入（import）不是同一操作，见 `reprise sessions --help` 与 `reprise import --help`。 |
| 模型连接失败 | 在 `/config` 核对 endpoint、API 协议类型（`openai-completions` / `openai-responses`）、模型 ID 和凭据来源。不要把配置全文粘贴到 Issue；用 `Ctrl+T` 连接测试并查看错误摘要。 |
| 恢复显示「无法恢复」或 blocked | 查看 TUI 或事件日志中的缺失条件；缺关键输入时不会启动候选，没有「强行继续」开关。 |
| 报告或图片入口不可用 | 区分未生成对照、未采集媒体、快照缺失和发布失败。空入口可能是数据尚未产生，不代表零差异。 |
| 取消后仍在收尾 | `Ctrl+C` 或 `reprise cancel` 发起取消请求；清理与最终状态在事件日志和结果页分别显示，二者可能不同步片刻。 |
| 同一实验再次运行失败 | 属于当前已知限制，见 [路线图](./roadmap.md#已知实现问题)。不要默认删除整个 `.reprise` 目录作为修复手段。 |
