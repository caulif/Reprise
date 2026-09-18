# 决策记录（ADR）

ADR（Architecture Decision Record，架构决策记录）回答「为什么选择 A、放弃 B」。它是仓库唯一因果层；当前行为见 [architecture](../architecture/overview.md) 与 [product](../product/overview.md)，未关闭目标见 [MASTER](../progress/MASTER.md)。无需读完全部 ADR 才能开工。

## 热集与冷库

| 目录 | 用途 |
|---|---|
| [accepted](./accepted/) | **热集**（≤ 40）：仍频繁约束实现；navigation 与 architecture/product 只链此目录 |
| [archive/accepted-2026-09/](./archive/accepted-2026-09/) | **冷库**：仍有效但已沉入 architecture 或极少改动的旧 accepted；**不进** `docs/README` 与根 AGENTS 导航 |
| [archive/superseded/](./archive/superseded/) | 已有替代规则的历史记录；**不进**导航 |
| [proposed](./proposed/) | 未拍板，或已确认但尚未实施生效 |

冷热分离立场见 [ADR 热集与冷库分离](./accepted/2026-09-18-adr-hot-cold-split.md)。不建 `.agents/notes/` 平行树，不维护手写全局 INDEX。

### 什么进热集

满足**任一**即可留在 `accepted/`：

- 仍约束跨模块协议、on-disk、prompt、工具面或门禁，且 fact 层仍可能挂 Markdown 链
- 仍被 architecture / product / 根或 docs AGENTS / 门禁文档 **Markdown 链接**
- 安全、凭据、平台支持、费用 opt-in

其余 → `archive/`。**工具面 / 协议类 ADR** 若规则已完全沉入 architecture/product 且 fact 层不再挂链、也不留标题伪引用，可入 `archive/accepted-2026-09/`（仍有效，仅退出默认视线）。移冷库用 `git mv`，不删历史。

## 何时写

跨模块协议、on-disk 格式、提示词契约、工具面、架构边界、工程流程或门禁变化，同批新增或更新相关 ADR；行为变化同时更新唯一事实归宿。测试证明当前行为，ADR 保存取舍，两者不能互相替代。

无契约变化的单点 bugfix、机械重命名、文档措辞修正、仅推进计划证据可豁免。PR 说明「无契约变化」及原因即可，不为小修改制造流水账。相关决定仍有效时优先补原记录；反转旧决定须新建替代记录。

## 生命周期与格式

| 目录 | 含义 |
|---|---|
| [proposed](./proposed/) | 未拍板，或已确认但尚未实施生效；写清生效验收 |
| [accepted](./accepted/) | **热集**：navigation 默认链到的现行约束（≤ 40） |
| [archive/accepted-2026-09/](./archive/accepted-2026-09/) | **冷 accepted**：仍有效、已沉入 fact 层或极少改动；不进导航 |
| [archive/superseded/](./archive/superseded/) | 已有替代规则；保留历史与替代链接 |

日期不随移动改变；部分迁移不能宣布整份旧决定失效。五节格式、命名及历史兼容规则由[文档结构](../documentation-structure.md#决策记录)定义。[写 ADR](../cookbook/add-adr.md)提供操作步骤。

备选方案写真实弃案与放弃理由，不用「没有其他方案」填空。验证写可观察命令、结果与边界，不用「已完成」代替证据。

## 如何检索

1. 先读 architecture/product 中的现行规范；只有需要取舍理由或怕重复弃案时再查 ADR。
2. 热集：`git grep -n "关键词" -- docs/decisions/accepted`
3. 冷库与替代历史：`git grep -n "关键词" -- docs/decisions/archive/`
4. 未落地提案：`git grep -n "关键词" -- docs/decisions/proposed`

```text
git grep -n "CandidateRun" -- docs/decisions/accepted docs/decisions/archive
git grep -n "Session" -- docs/decisions/proposed
```

检索是为避免重复弃案，不维护全局 ADR INDEX 或第二套 notes。规则与事实只链接到其归宿，不在 ADR 全文双写。
