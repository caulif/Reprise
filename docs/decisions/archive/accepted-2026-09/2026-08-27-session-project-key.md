# 决策：Session 项目 key 由共享函数生成

状态：accepted

## 问题

Codex adapter 用手写 `codex\0` + 路径小写拼接项目 key，TUI 再用另一套 `productId + cwd` 规则分组。同一 Windows 根目录会出现项目节点和会话节点分离；assignment 为空的当前项目会话也无法稳定落到 Desktop 项目下。

## 决定

`sessionProjectKey(productId, canonicalRoot)` 与 `canonicalRecordedRoot` 是唯一项目 key 算法。Codex catalog 的 `projects` 与 TUI `groupSessionsByProject` 都调用它。Codex 归属由 `classifyCodexProject` 按 assignment、SQLite `project_id`、workspace hint、cwd 匹配已知根的顺序判定；冲突只产生诊断，不丢弃会话。assignment 指向未知项目时分类为 `unknown`。`projectless-thread-ids` 进入项目外会话。rollout-only 在 cwd 落在已知 catalog 根下时加入该项目，否则进入项目外。

## 备选方案

**继续让 Pack 与 TUI 各自拼接 key。** 路径规范化一旦分叉，空项目和有会话项目会同时出现。

**只用 SQLite `project_id` 分组。** Desktop 把归属放在 `thread-project-assignments`，当前项目大量 `project_id` 为空。

## 影响

- TUI 不再私有一套 cwd key。
- 未知 assignment 显示为未知项目，不静默删除。
- cwd 匹配项目根必须走 `canonicalRecordedRoot` / `pathContainedBy`。

## 验证

- `test/codex-catalog.test.ts`：assignment 覆盖空 `project_id`；未知 assignment 保留；adapter/TUI key 相同。
- `test/intake-ui.test.ts`：unindexed 在无 catalog 时进项目外，cwd 位于 catalog 根下时并入该项目。
