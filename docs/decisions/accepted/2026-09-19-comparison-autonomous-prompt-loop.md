# 决策：Comparison 自主任务比较 Prompt 与四轮闭环

状态：accepted

它替代[视觉优先版式](../archive/accepted-2026-09/2026-09-19-comparison-visual-first-card.md)中「卡面只允许 pair-pages + 至多三条 bullet、单侧必须留空、固定 visual→diffs 区域顺序」的 **Prompt 契约**；[可分享任务比较卡](./2026-09-09-comparison-shareable-task-card.md)的产品目标仍有效。Host 模板 DOM/`AGENT_ZONES` 与发布预处理由证据目录与报告区域包另行落地；本决定约束可执行 Prompt 与同 Session 证据闭环。

## 问题

视觉优先 Prompt 把版式实现细节（pair-pages、隐藏组件、固定区序）写进 Agent 合同，导致非视觉任务仍被逼成图框、单侧真实证据被禁止展示，审阅只靠重开 HTML 文本。动态 catalog 注册的新引用若在 `compare()` 开头拍成 Set，会在同 Session 内被静默丢掉。

## 决定

- 唯一可执行文本源仍是 [`comparison-agent.ts`](../../../src/agents/comparison-agent.ts)：`COMPARISON_SYSTEM_PROMPT`、`COMPARISON_TURN_PROMPTS`、`COMPARISON_COMPACTION`、Host-zone repair、JSON-only repair。
- System Prompt 以任务成功标准与用户后果为中心；证据形式由 Agent 选择；图片非每任务必选；单侧可展示并就近说明限制；禁止跨任务排名与伪造观察。
- Workspace 指向 `facts/` catalog、`finals/`、`history/`、`candidate/`，并点名 `render_artifact` / `register_evidence` / `preview_report`。
- 四轮保持 understand → investigate → compose → review；compose 写 `data-agent-zone="comparison"` 与可选 `details`；review 必须 `preview_report`，改稿后重检。
- `getEvidenceCatalog()`（同进程）优先于一次性 `shortEvidenceRefs`；非法短引用不得静默滤成空数组后成功，须提示未知 ref 与当前 catalog，并走既有有限 JSON repair（禁工具）。
- Host-zone repair 保留 Agent 的 comparison/details 创作，只恢复 Host 区域。

## 备选方案

**只改 snapshot/文档不改代码 Prompt。** 可执行合同仍是旧视觉优先指令；拒绝。

**取消四轮、改成单轮自由创作。** 失去调查与预览强制点；拒绝。

**未知引用继续静默丢弃。** 动态注册证据无法进入信封；拒绝。

## 影响

- Prompt 快照 `comparison-system-prompt.txt`；`comparison-agent-phases` / `comparison-report` 流程与措辞测试。
- 事实层：[证据与 Comparison](../../architecture/evidence-and-comparison.md)。
- 依赖 Host 侧已合入的证据 catalog（B3）与报告区 format-2（B6）；`render_artifact`/`preview_report` 完整体仍随 B4，本包可用 fake 或 Host stub 验证 Prompt 闭环。

## 验证

- `node --test dist/test/application/comparison-agent-phases.test.js`：同 Session 注册→compose→preview→引用新 ref；改稿后二次 preview；text-only 无 visual claim；工具失败有具体限制；未知 ref 触发 JSON-only repair 且不重写页面。
- `node --test dist/test/application/comparison-report.test.js`：Prompt 含 comparison/details 与 preview_report，不含 pair-pages/单侧留空。
- `npm run check` 必须通过。
