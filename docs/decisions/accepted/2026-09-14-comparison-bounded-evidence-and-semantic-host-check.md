# 决策：Comparison 有界证据索引与语义 Host 校验

状态：accepted
日期：2026-09-14

## 问题

Comparison 把工作区 `changedPaths` 全量展开成证据 links，大型仓库会在 Agent 启动前因短引用 schema 崩溃。另一类失败来自把 Host 区域的 HTML 排版差异当成事实修改，以及把非标准但非空的 Agent 分析覆盖成空白失败页。

## 决定

证据索引只包含可解释、可复查的历史回复、候选可见结果、关键 artifact、媒体和用户可见交付文件。工作区快照中任意路径段上的 `.git`、缓存、构建输出、`.venv` 和 Harness 内部文件不属于默认 comparison links。索引最多保留 64 项；briefing 中的 `changedPaths` 只列出已进入索引的交付路径。被排除或截断的数量作为 Host fact 和 sidecar 记录。

短引用使用 `ev-` 加 2 至 6 位数字。这个范围是协议防御，不代表允许把完整工作区清单发送给 Agent。

Host 区域完整性按解析后的结构、事实字段和指标值比较。空白、属性顺序、引号和 HTML 实体编码不构成修改；Host zone、metrics、费用和证据结构的真实变化仍阻止发布。

发布失败时保留 attempt 中的草稿。失败页写入已有 headline 与标准 Agent 区域；非标准但非空的 Agent zone 提取到诊断摘要。入口 briefing/schema 失败为 `publication_failed`；Agent 执行中的未分类异常为 `agent_failure`；信封断言失败为 `invalid_envelope`。

## 备选方案

**只把 shortRef 改成长数字。** 仍把数百条内部路径送给 Agent，调查入口不可用。

**按失败样本特判。** 同类工作区规模和 HTML 序列化问题会再次出现。

**把任意 Agent zone 当作成功结构。** Host 无法保证首屏契约，也无法区分结构错误与有效分析。

**继续比较 Host 区域原始 HTML 字符串。** 属性顺序、引号和实体编码会被误判为事实篡改。

## 影响

Agent 仍使用一个 Comparison Session 和四个阶段。完整文件清单可作为审计资料保留，但不进入默认 briefing 索引。规则补充 [首屏清晰度与审阅改页](./2026-09-14-comparison-report-clarity-and-review.md) 与 [Host 区域与直接 HTML](./2026-09-13-comparison-host-zones-and-direct-html.md)。

## 验证

`test/application/comparison-tracks.test.ts`：内部路径（含嵌套 `.git`）不进入 links；briefing 的 `changedPaths` 不超过索引上限。`test/application/comparison-report.test.ts`：`src/__pycache__` 排除；无 allowlist 时合法 `ev-01` 保留。`test/application/comparison-publication.test.ts`：标准 Agent zone 正文进入失败页。反向：嵌套 `.git` 进入默认 links、失败页丢掉 `key-differences` 正文、或空 allowlist 丢掉合法短引用则红。`npm run check` 必须通过。
