# 开发与验证

## 开发环境

图片链路的日常回归使用 fake Provider 与不可变附件，不调用真实服务。`config test-image` 另需显式 `REPRISE_RUN_IMAGE_PROBE=1`，可能产生费用；没有真实模型探测及任务验收时，PR 必须明确边界，不能把能力声明或离线 passed 当成上游已验证。协议与授权决定见[原生图片链路 ADR](./decisions/accepted/2026-09-30-comparison-native-image-pipeline.md)。

需要 Git、Node.js 和 npm；版本以 [package.json](../package.json) 的 engines 为准。在仓库根运行 `npm ci`，然后 `npm run build`。构建重建 dist；默认开发检查不需要登录产品或模型密钥。使用入口见[使用指南](./usage.md)。

Windows 11 是唯一经过真实使用验证的平台。CI 的平台矩阵由 [check.yml](../.github/workflows/check.yml) 定义，模拟测试通过不等于真实 Runtime、文件权限或终端输入体验已验证；剩余验证见[路线图](./roadmap.md)。

测试 lane 结束后另跑独立浏览器诊断：记录实际启动路径、可执行文件与 CDP 的版本一致性，并创建真实页面 target。该步骤不阻断，也不替代原来的真实预览与发布绑定测试；用来区分并行测试时的启动故障和独立启动故障。Linux 已安装 Chrome 时优先其原生二进制，保留其他浏览器候选；生产 DevTools 启动等待仍为 15 秒。

## 验证命令

| 改动或目的 | 命令 |
|---|---|
| 仅 Markdown 文档 | `npm run verify:docs` |
| 代码迭代中的快速反馈 | `npm run check:fast` |
| 代码改动收尾 | `npm run check` |
| 单项回归 | `npm run build` 后 `node --test dist/test/<对应文件>.test.js` |
| 全部测试 | `npm test`；仅构建已同步时使用 `npm run test:only` |
| 覆盖率 | `npm run test:coverage`，不在普通 check 中重复执行 |
| 发布前检查 | `npm run check:full`；与 check 的具体关系以编排脚本为准 |
| 修改 schema 或生成模板 | `npm run build`、`npm run gen:docs`、`npm run verify:generated` |
| TUI 渲染 | `npm run audit:tui:check`，代码收尾仍跑 check |

测试 runner 可显式传 `--concurrency N`（安全正整数），例如 `node scripts/run-gates.mjs test --concurrency 2` 或 `npm run test:coverage -- --concurrency 1`；省略时保持 Node 默认。Linux CI 的测试采用 2、覆盖率采用 1，Windows/macOS 默认不变；这是 CI 资源调度，不改变真实浏览器的产品超时与断言。`node scripts/run-tests-temp-guard.mjs --self-test` 验证非法并发参数被拒绝。取舍见[Linux CI 测试并发](decisions/accepted/2026-10-06-linux-ci-test-concurrency.md)。

测试读取 dist，源码或测试变化后必须先构建；不能直接用 `node --test` 跑 TypeScript。lint 与类型检查分别检查不同问题，不能互相替代。按风险选择检查，不为一项文档修改重复执行全套测试。

测试维护原则与 Comparison 场景入口见[测试覆盖索引](../test/README.md)；文件存在不代表能力通过。历史 cwd 使用临时项目，恢复样本按不同内容与扰动执行，权限不足仅跳过对应子用例；退避协议使用虚拟时间，真实系统边界仍保留集成回归。取舍见[行为测试维护决策](decisions/accepted/2026-10-14-behavior-focused-test-maintenance.md)。

## 工程门禁

[run-gates.mjs](../scripts/run-gates.mjs) 定义本地检查，[CI workflow](../.github/workflows/check.yml) 定义 CI lanes。字段、阈值和检查列表以脚本与配置为准，不维护第二套手写清单。

静态检查覆盖类型、lint、文档链接与预算、生成区、供应链、秘密、层级导入及受控源码。测试、未使用导出与重复代码检查负责行为和维护边界。npm 由 [npm-cli.mjs](../scripts/npm-cli.mjs) 解析后通过 Node 启动，避免 Windows shim 启动差异。

Windows TUI 帧与 [frames](./tui-audit/frames/) 逐字节比对并检查布局；非 Windows 的 audit 只生成与自检，不可覆盖 Windows 基线来消除差异。schema 字段表由 [生成器](../scripts/gen-docs.mjs) 产生，不手改生成区。

### 门禁必须能失败

新增或修改门禁必须同批包含能使其失败的自动化用例。覆盖率阈值只能升不能降，重复代码阈值不能放宽；不得以例外或非阻断失败隐藏问题。原因见[反向用例决策](./decisions/accepted/2026-08-15-gate-reverse-tests.md)。

失败证据应包含命令、退出码或启动错误、Node/OS 与提交信息。编排器的 `--self-test` 会故意构造失败；它证明诊断有效，不是产品失败。记录未运行的检查及原因，不能把 Agent 总结当作验证。

## 真实调用与费用

默认开发检查和 CI 不运行真实模型或 Runtime。真实调用必须明确授权，并设置对应脚本要求的环境变量；不要把开关加入日常验证默认值。普通 fixture、协议 probe 和完整任务验收是不同证据。

Codex 协议 smoke 的 PowerShell 示例：

```powershell
$env:REPRISE_RUN_CODEX_SMOKE = '1'
npm run smoke:codex
Remove-Item Env:REPRISE_RUN_CODEX_SMOKE
```

此命令会构建并执行 [codex-real-smoke.ts](../scripts/codex-real-smoke.ts)，验证无工具请求返回约定文字。它可能计费，既不执行完整实验，也不证明 Recovery、Controller 或报告效果。其他真实 runner 的入口、必填输入与 opt-in 以 [scripts](../scripts/) 中对应文件为准；不要复用过期样本路径或运行记录冒充新证据。真实验收缺口集中在[路线图](./roadmap.md)。

## Comparison 产品质量评估

[`comparison-evaluate.ts`](../scripts/comparison-evaluate.ts) 使用[冻结 suite](../test/fixtures/comparison-evaluation/suite.json) 的 12 个合成样本，每类任务至少两例，覆盖结果相近、过程归属、反证与缺失记录。`prepare` 只生成隔离 Case/Experiment 输入，不调用模型或 Runtime；`real` 对这些已冻结输入调用生产 Comparison，不重做候选任务。默认三次重复、原序/交换/匿名三种变体共 108 项；可先准备一次重复的 36 项，再通过 `--case <id>` 选择样本、`--max-rows 1` 限定首次只执行一项。匿名变体隐藏夹具身份，不代表生产链路完全盲化。

```powershell
npm run build
$comparisonEvalOutput = 'C:\reprise-eval\comparison-validation'
node dist/scripts/comparison-evaluate.js prepare $comparisonEvalOutput --repetitions 3
```

输出目录必须绝对路径且不存在，suite hash 与输入计划落盘后保持不变。真实生成需要另行明确授权、既有 Harness 配置目录、费用范围及停止条件；以下命令可能计费，不能放入默认 check 或 CI：

```powershell
$comparisonConfigDir = 'C:\reprise-config'
$env:REPRISE_REAL_MODEL = '1'
node dist/scripts/comparison-evaluate.js real $comparisonEvalOutput $comparisonConfigDir
Remove-Item Env:REPRISE_REAL_MODEL
```

runner 只读取现有 Harness 配置，不复制凭据；逐项记录实际模型、输入能力、report hash、耗时、请求、工具、压缩、重试、预览、usage 覆盖及估算费用。缺失 usage/价格保持未知；连续三次失败或取消停止，`Ctrl+C` 取消。默认生产工厂使用一个自主 Comparison Session，由整体时间预算约束调查、编写、预览与修订；当前预算及 override 语义见[Comparison attempt](./architecture/evidence-and-comparison.md#comparison-attempt)。空资源 override 不关闭默认整体截止；显式请求数、工具数和费用限制继续执行，单次调用使用实际剩余整体时间与调用上限的较小值。默认流程没有调查阶段配额或独立来源复审窗口。运行前仍须限定总评估范围。异常来源或终稿材料造成的持续调查只能作为资源风险证据，修正输入身份之前不能形成质量基线。单例 `--case` 使用单独 ledger，不自动成为完整矩阵验收。

当前自主发布回归从实际 Harness 工厂与 Host 工具入口运行，验证 fragment 提交、当前 digest/catalog 的预览回执进入同 Session 后续 generation，以及发布和离线恢复。缺失提交、未交付预览、正文或 catalog 变化、取消、调用失败与审计失败不得通过完成检查；实际生产入口用例见[自主发布回归](../test/application/comparison-autonomous-publication.test.ts)。这些完整性检查不认证报告判断或视觉质量。

以下来源复审、核稿正文检查点和决策摘要要求只适用于旧多阶段 Comparison 兼容端口与对应历史协议回归，不是当前自主流程的前置条件。历史请求按原协议标记校验，不能把缺失独立复审证据的旧报告降级成自主完成；协议范围见[证据与对照](./architecture/evidence-and-comparison.md#comparison-attempt)。

来源复审的局部截止与完整 turn 软让出分别审计：检查调用开始事件的绝对 deadline/reason、真实生成/工具与 usage、idle 后的 yielded 原因及下一次核稿输入。局部中止可能没有可见 assessment，不能把它统计为完成验证；不把普通 Provider timeout、用户取消或整体硬限映射成局部让出。逆例需验证真实 idle/usage 前不开始下一阶段、同 Session 后续调用可用，以及取消与真实错误优先。

核稿正文检查点需以真实工具成功交付验证，覆盖 current/stale 完整材料、未完成回调、审计失败、缺失/过大文本、revision/epoch 失效、调用次数与取消硬限。stale material 不得满足正式 inspection 或发布认证；工具白名单不取代执行限制，旧 Provider 忽略曝光字段仍不得产生其它工具副作用。

决策摘要契约需覆盖缺字段、空白摘要、已有重要限制却交空边界、HTML 文本转义及摘要与边界计入主文总长度的逆例；实际 inspection 和持久化比较区必须包含这些段落。真实语义审核另核任务可用性、关键质量维度及重要未知是否被压缩掉，不将有摘要字段等同于判断正确。

生成成功只表示报告发布链路通过。人工检查对应报告后，在 ledger 的 review 字段按当前 schema 记录决定性事实、限制、错误、过程误归属、反证处理、30 秒可读性与规范化到原始双方的取舍；review 必须绑定报告 hash。随后对完整 ledger 执行：

```powershell
node dist/scripts/comparison-evaluate.js assess $comparisonEvalOutput 'C:\reprise-eval\comparison-assessment.json'
```

统计报告区分已生成与已人工审阅，汇总遗漏、错误、资源分布和重复/变体漂移；有条件推荐变化须人工解释，不能机械要求赢家一致，也不输出模型总分或排名。正文长度与提交回执共用生成报告的计数口径：结论加主比较区，折叠 details 只计 summary，展开则计正文，排除模板与独立详情区，不从评审猜测。`manual_review_recorded` 只说明人工记录齐全，不宣称语义自动通过；假输入和协议回归不能替代真实模型质量验收。协议见[关键发现与资源保护 ADR](./decisions/accepted/2026-10-05-comparison-scoped-findings-and-resource-protection.md)。

## Comparison 通用工具试验

用[独立试跑入口](../scripts/comparison-coding-trial.ts)对照模型侧协议的影响：同一个 prompt 驱动通用文件、Shell、图片、裁切和浏览器工具，直接生成完整 HTML，不经过正式报告的证据登记、片段提交及预览绑定。它不是默认 Comparison，也不覆盖正式报告，边界见[试验决策](./decisions/accepted/2026-10-12-comparison-coding-trial.md)。

先 `npm run build`。准备仅含任务材料和交付物的独立副本、一个描述交付目标的 UTF-8 prompt 文件，以及不存在的输出目录。四个参数均为绝对路径：

```powershell
$env:REPRISE_REAL_MODEL = '1'
node dist/scripts/comparison-coding-trial.js C:/trial/inputs C:/trial/run-01 C:/reprise-config C:/trial/prompt.txt
Remove-Item Env:REPRISE_REAL_MODEL
```

真实调用可能计费。输入不得使用生产工作区或凭据目录；Shell 沿用现有命令检查，不是操作系统沙箱。工具中的 `source/` 是只读文件挂载，Shell 使用 `REPRISE_SOURCE_MOUNT`。工作文件在输出的 `work/`，完整模型输入与图片审计在 `audit/`；输入前后 hash、耗时和执行状态在 `summary.json`。仅设24 小时整体截止，没有请求或工具次数配额。正常结束、完整 HTML 存在且输入未变才记为 completed，语义质量仍需独立检查。

仓库提供[通用报告骨架](../scripts/comparison-report-template.html)与[配套提示词](../scripts/comparison-report-prompt.txt)。将骨架复制到专用输入副本的 `report-template.html`，并按实际输入调整提示词末尾的任务描述，再将提示词绝对路径作为第四个参数。骨架仅保留总体判断、关键差异和运行指标，证据紧邻对应差异，不设置补充详情或方法附录；指标使用 h/m/s、总 Tokens 的 k/M 缩写及美元估算费用。具体展示约定由提示词拥有。模板与计量材料和其他输入一样纳入 hash 与模型输入审计，不包含本机样本结论；调用者也可使用自己的 prompt 和骨架。

## 发布与回滚

发布包名为 `@caulif/reprise`，CLI 名为 `reprise`；裸名 npm 包不是本项目。发布前确认版本、tag、CHANGELOG 与持久化兼容策略一致，在干净检出执行安装与 check，并核对打包、依赖审计、秘密扫描结果。check 已覆盖的检查仅在证据失效时重跑。

先审查 `npm publish --access public --dry-run` 的文件清单；正式发布与推送 tag 属于外部写入，须由有权限的维护者执行。打包不得包含用户会话、凭据或本机实验。

故障版本可由维护者弃用，并验证回退版本能读取现有数据；没有兼容退路时保留原始数据并说明限制，不能原地改写未知版本 journal。事故记录至少说明影响、根因、修复、回归证据和剩余风险，可沿用 Issue，无需另建模板文件。
