# 产品优先的会话 Intake

- 状态：接受
- 日期：2026-08-15

## 问题

跨 Product Pack 并行发现会话会在打开 `/intake` 时产生不必要 I/O。合并后的全局上限还能让较新的一个产品会话挤掉另一个产品；相同项目路径也会混合来源。

## 决定

`/intake` 先从静态 `productPacks` 注册表渲染产品。选中一个产品后才调用它的 `SessionSourceAdapter`。发现结果、上限、项目分组、搜索和错误在进程内按 `productId` 隔离。freeze 从所选 `SessionSummary.productId` 在当前 Pack 集合中解析 Adapter；运行 workflow 继续从 `TaskCase.source.productId` 选择候选与 Runtime。

## 备选方案

- 增大全局会话上限：不能消除跨产品挤占和启动 I/O。
- 在项目行加产品标签：不能提供惰性发现或错误隔离。
- 扫描插件目录动态加载：扩大供应链和执行边界，超出静态 Product Pack 架构。

## 影响

产品即使尚未扫描、没有会话或运行环境不可用也会显示。会话 cache 只在当前 TUI 进程保留；不做 watcher、TTL 或持久化索引。

## 验证

`test/codex-intake.test.ts` 断言打开 Intake 不调用任何 Adapter，选择 Claude Code 时只调用 Claude Adapter，并验证相同 cwd 的产品结果不混合。完整门禁使用 `npm run check`。
