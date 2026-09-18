# 决策：ADR 热集与冷库分离

状态：accepted

## 问题

约 192 份 `accepted/` ADR 与 architecture/product 同树展示，开源读者与 Agent 默认视线被因果层淹没。DSH 用 `.agents/notes/` 物理分离因果与事实，但 Reprise 已选定 `docs/decisions/` 为唯一因果层，不宜再建平行 notes 树。需要在不删 git 历史、不手写全局 INDEX 的前提下，让人与 Agent 默认只触达仍频繁约束实现的热集。

## 决定

1. **热集**继续留在 `docs/decisions/accepted/`，目标 ≤ 40 篇：跨模块协议、on-disk、prompt/工具面、门禁、安全/凭据/平台/费用 opt-in，或仍被 architecture/product/导航引用的现行规则。
2. **冷库**整包迁入 `docs/decisions/archive/accepted-2026-09/`；`superseded/` 迁入 `docs/decisions/archive/superseded/`。文件名与日期不变，用 `git mv` 保留历史。
3. **导航只链热集**：`docs/README`、根/`docs` AGENTS、architecture/、product/ 不链冷库；冷库靠 `git grep docs/decisions/archive/` 检索。
4. **不建** `.agents/notes/` 或第二套 Agent Notes；不把冷 ADR 正文粘回 architecture。
5. `verify:docs` 对 `decisions/archive/` 豁免决策模板与出站断链全量巡检（冷库仍受 Git 跟踪，检索不受影响）。

## 备选方案

**平行 `.agents/notes/`（DSH 式）。** 因果层分裂为 ADR + notes，检索面与工具链 duplicated；与既有「decisions 唯一因果层」立场冲突。

**独立 archive 分支/submodule。** 追溯 OK，但 clone 与链接校验更重；同仓 `archive/` 更简单。

**全部留 accepted、只靠 README 声明不要通读。** 文件仍在默认路径，Agent 与搜索仍易扫入全文。

## 影响

- 新增与替代 ADR 默认进热集；仅当规则仍有效但已完全沉入 architecture 且极少改动时，可在后续变更中迁入冷库。
- plan/archive/ 与 MASTER 可链冷库路径；architecture 对冷库只保留已内联的正文，不再挂链接。
- 触发热/冷边界或 `verify:docs` 归档策略时，更新本记录与 [decisions/README](../README.md)。

## 验证

- `ls docs/decisions/accepted/*.md | wc -l` ≤ 40。
- `npm run verify:docs` 退出 0。
- `git grep 'decisions/archive/' docs/architecture docs/product docs/README.md AGENTS.md docs/AGENTS.md` 无命中。
- `git grep 'decisions/accepted/' docs/architecture docs/product |` 对每条命中路径，`basename` 均在热集清单内。
