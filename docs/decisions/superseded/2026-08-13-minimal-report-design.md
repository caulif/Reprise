# Reprise 报告设计稿（极简版）

日期：2026-08-13
定调（项目所有者决策）：

1. **过程检视归 TUI**：运行中看时间线，已有能力，不再往报告里搬过程呈现。
2. **报告是 agent 写的一份 HTML**：compare 结束产出单个 report.html，正文内容与结构由 Comparison Agent 自行决定。
3. **更细的内容用户自己翻文件**：事件日志、workspace scope、快照都在磁盘上，报告只需给出入口，不做内建查看器。

> 本稿替代此前"账本 + 导览层"两权分立方案——该方案被判定为过度设计，已放弃。

---

## 1. 报告结构

report.html = **一层薄确定性外壳 + agent 正文**：

### 1.1 确定性外壳（Host 渲染，维护成本接近零）

- 标题：caseId、候选模型、运行时间；
- 一行指标：turns · wall-clock · changed files · tokens（`RunInspection` 已算好）；
- 一句固定标注："单次运行，结果受随机性影响；本报告不是排名"；
- 文件入口：experiment 目录下各 artifact 的相对路径清单（`store.listArtifacts`）——这是"用户自己翻文件"的入口。

### 1.2 agent 正文（comparison.md，结构自定）

- Comparison Agent 的契约不变（`ComparisonResultSchema`：completed / insufficient_evidence + comparison.md + evidenceRefs + limitationCodes）；
- system prompt 补一句职责声明：**comparison.md 是用户看到的唯一正文**，由你决定展示什么、如何组织；需要引用细节时写 artifact 相对路径，用户会自己打开文件；
- 正文以 Markdown 写作，Host 转义后嵌入 HTML（现有 `<pre>` 方式即可；若做极简 Markdown 渲染，仅限标题/列表/代码块，自写、全转义）。**agent 不产出原始 HTML**——这是唯一不可让步的安全边界。

### 1.3 失败降级

agent 超时/输出无效时，report.html 照常生成：外壳完整 + 一句"No validated comparison narrative is available" + 文件入口清单。用户仍有路可走。

---

## 2. 现有代码的收缩

- `renderTask` 的两列 facts-grid、`renderRun` 的 Candidate facts 明细：**从 report.html 移除**（事实仍在磁盘 artifact 里，正文要不要讲由 agent 决定）；
- `displayText` 的无条件路径打码默认关闭（报告在本机、给主人看；转义与截断保留）；
- `ComparisonContext` 维持现状（状态摘要 + finalMessage + evidence refs），agent 用 `read_artifact` / `read_observation` 自行按需深挖——"自己决定展示什么"的前提是自己去看。

## 3. 不做清单

1. 不做 findings 结构化契约、锚点系统、导览层；
2. 不采集 beforeSnapshots，不做 diff / 逐轮对话区块；
3. 不做交互式报告、前端框架、语法高亮；
4. 不做分享版导出（去敏、自包含单文件）——未来需要时作为独立动作；
5. 不给 agent 原始 HTML 输出权。

## 4. 测试影响

- `comparison-report.test.ts`：facts-grid 相关断言删除；外壳（指标行、标注、文件入口、降级页）断言新增/调整；去敏行为断言更新；
- agent prompt 变更不影响契约 schema，现有校验用例保持。

## 5. 已知取舍（记录在案，不再重议）

- 报告质量随 agent 发挥波动，无结构化校验兜底——接受，降级页保证最低可用；
- agent 决定展示即决定省略——接受，磁盘上的完整事实是最终仲裁，报告定位为"导读"而非"账本"。
