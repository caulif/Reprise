# 决策：自主任务比较与可分享报告

状态：proposed

用户已确认 Comparison 改造目标（handoff B5–B8、B9）；proposed 表示等待相关实现合入后再生效。产品目标仍见[可分享任务比较卡](../accepted/2026-09-09-comparison-shareable-task-card.md)。

## 问题

固定四槽与「必须成对图」迫使非视觉任务套截图模板；CSS 隐藏有效表格；单侧真实证据被剥掉；无效 Controller 引用被静默丢弃；文本模型能力与视觉声明混为一谈。结果是分享卡难读，且限制与证据强度不诚实。

## 决定

确认后生效时采用下列边界：

1. **Agent 主创作区。** 新报告格式以 `data-report-format="2"` 收敛为 `comparison` + 可选 `details`；Host 保留 header/style/metrics 与可追溯 details。取消「卡面只允许 pair-pages + 至多三条 bullet」与固定 `visual < diffs` 顺序作为成功硬条件。
2. **单侧可降级。** 一侧不可恢复时可展示有证据一侧并就近写明缺失原因；不得用占位美图或草稿冒充对侧终稿。非视觉任务不以图片为必选主体。
3. **真正预览。** `preview_report` 用当前 catalog revision 解析草稿；返回机械加载/布局事实；preview 后改稿须重检。预览图属 host review，不自动登记为 baseline/candidate 媒体。
4. **发布顺序。** 先复制并校验被引用资产，再写审计 model，再原子替换根 `report.html`；旧 HTML 引用的资产永不原地覆盖。
5. **媒体能力声明。** Harness 配置可选 `inputCapabilities`：`['text']` 或 `['text','image']`；文本路径不发送 image block、不声称已观察；视觉路径审计可复原实际输入。
6. **Prompt 唯一入口。** System / 四轮 / compaction / repair 只改 `comparison-agent.ts`；工具名与 B3 catalog 一致；同 Session 闭环。
7. **Controller / Recovery 小修。** 无效证据引用不得静默过滤；工具返回须让模型看见真实 ref；用户沉默≠验收；Recovery 明确 `source/` 虚拟路径与 `REPRISE_SOURCE_MOUNT`。

## 备选方案

**只改 Prompt、不改区域与发布。** 无法解除 CSS/白名单/成对硬门；拒绝。

**保留视觉优先四槽并放宽成对。** 仍把非视觉任务锁进截图模板；拒绝整份版式契约，局部保留身份/metrics 纪律。

**给 Controller 直接复用 Comparison 历史终稿视图。** 越权成评分器；本轮不做。

**为每个任务类型写专用报告模板。** 与「通用推理与表达」目标冲突。

## 影响

- `comparison-report-shell` / `comparison-html` / publication / visual-evidence / schema / strings / agent prompts / harness config / Controller / Recovery。
- **替代**[视觉优先版式](../accepted/2026-09-19-comparison-visual-first-card.md)中：固定 DOM 顺序 `visual-evidence`→`key-differences`、`.share` 内隐藏 diff-table 等组件、compose「只用 pair-pages + 短 bullet」、无成对图即剥单侧图等条款。
- **仍有效**：Host 身份与 metrics 不可篡改、离线自包含、失败不覆盖成功报告、不跨任务排名、薄信封无总分赢家枚举——这些继续受[可分享任务比较卡](../accepted/2026-09-09-comparison-shareable-task-card.md)与 Comparison 架构约束。
- 旧 `report-model` 缺省 legacy 可读；不批量改写历史报告。

## 验证

生效验收（B5–B8 合入且 B9 矩阵勾选后）：

- 代码/文本/数据样例可无强制图框发布；真实表格不被 CSS 隐藏；关键限制在主区可见。
- text-only 与 image 能力路径均有消息级测试；preview digest 在改稿后失效。
- Controller：路径伪引用触发修复；合法 read ref 进入 decision；无后续用户消息不要求「已验收」措辞。
- `npm run check` 通过；场景矩阵见 `test/application/comparison-acceptance-matrix.test.ts`。
