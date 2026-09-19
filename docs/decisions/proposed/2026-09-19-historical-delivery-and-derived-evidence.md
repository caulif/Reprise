# 决策：历史交付与派生证据

状态：proposed

用户已确认 Comparison 改造目标（handoff B1–B4、B9）；proposed 表示等待 B1–B4 实现合入后再生效，不要求重复确认设计。现行视觉优先版式见[对照卡视觉优先](../accepted/2026-09-19-comparison-visual-first-card.md)；产品目标仍见[可分享任务比较卡](../accepted/2026-09-09-comparison-shareable-task-card.md)。

## 问题

历史终稿与任务起点混用、旧 Case 缺少可复现字节、比较过程中新证据无法进入白名单时，报告无法可靠展示真实交付，也无法区分原件、重建件与派生预览。

## 决定

确认后生效时采用下列边界（实现归宿在 architecture / Pack / application，本记录只固定取舍）：

1. **两种快照分开。** 环境 baseline 是任务开始前输入；历史交付证据是任务结束后结果。历史交付永不进入候选 workspace。
2. **Pack 可选提取。** `ProductHistoryReader` 可提供规范化历史产物提取；未实现的第三方 Pack 仍可加载。提取只消费已冻结/脱敏历史，不执行历史程序，不读取实时用户目录猜终稿。
3. **旧 Case 补证落在 attempt。** 有合法 manifest 则核 hash 使用；否则对已冻结 transcript/events 提取，结果写入本次 attempt 的 `derived-history/`，不回写旧 Case。
4. **动态 evidence catalog。** attempt 作用域 revision；短引用 append-only；注册先校验再持久化再对模型可见；权威 manifest + 原子 current 指针。
5. **来源与派生分开。** 原件、重建、派生预览、观察检查、会话声明分字段记录；`origin` / `derivation` 由 Host 决定，Agent 不得自填历史原件身份。
6. **事件可复原。** 新增模型可见输入与 catalog 修订留事件（如 `comparison.evidence_registered`）；大内容走 immutable artifact；不含凭据与私人绝对路径。
7. **权限双条件。** 媒体进入模型请求须同时满足 privacy/发送授权与 `inputCapabilities`；catalog `available`  alone 不构成发送授权。

## 备选方案

**只在新导入路径封存，不管旧 Case。** 无法修复本次已冻结运行；拒绝。

**把历史 HTML 直接塞进候选 baseline。** 破坏两种快照分离；拒绝。

**全局证据服务 / 数据库。** 超过本轮需要；attempt 内轻量 catalog 足够。

**执行历史 shell/JS 还原文件。** 安全与确定性不可接受；只允许边界清楚的静态规范化写入。

## 影响

- Pack 契约、freeze、旧 Case 补证、historical discovery、`finals/` 挂载、comparison tools、schema、事件与持久化顺序。
- 替代[视觉优先版式](../accepted/2026-09-19-comparison-visual-first-card.md)中「Host 仅预填成对 media / 无图即 unavailable」对**历史侧缺 media 记录但可重建字节**的隐含假设；成对展示纪律在报告 ADR 中重述，身份与事实保护仍有效。
- 不替代可分享任务比较卡的产品目标；不授权跨任务排名或独立视觉裁判。

## 验证

生效验收（B1–B4 合入且 B9 矩阵勾选后）：

- 旧 Case、refs 为空时仍能从冻结补丁得到可打开历史 HTML；候选 baseline 不含该答案。
- 同 Session 注册新媒体后短引用可引用且旧编号不变；发布先资产后 HTML；两 attempt 不串媒体。
- 恶意路径/非静态补丁/外网请求在提取或渲染边界失败；CandidateRun 不受渲染取消影响。
- `npm run check` 通过；相关 suite 见 `test/application/comparison-acceptance-matrix.test.ts`。
