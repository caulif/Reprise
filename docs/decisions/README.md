# 决策记录（ADR）

ADR（Architecture Decision Record，架构决策记录）回答「为什么选择 A、放弃 B」。它是仓库唯一因果层；当前行为见 [architecture](../architecture/overview.md) 与 [product](../product/overview.md)，未关闭目标见 [MASTER](../progress/MASTER.md)。无需读完全部 ADR 才能开工。

## 何时写

跨模块协议、on-disk 格式、提示词契约、工具面、架构边界、工程流程或门禁变化，同批新增或更新相关 ADR；行为变化同时更新唯一事实归宿。测试证明当前行为，ADR 保存取舍，两者不能互相替代。

无契约变化的单点 bugfix、机械重命名、文档措辞修正、仅推进计划证据可豁免。PR 说明「无契约变化」及原因即可，不为小修改制造流水账。相关决定仍有效时优先补原记录；反转旧决定须新建替代记录。

## 生命周期与格式

| 目录 | 含义 |
|---|---|
| [proposed](./proposed/) | 未拍板，或已确认但尚未实施生效；写清生效验收 |
| [accepted](./accepted/) | 当前仍约束实现 |
| [superseded](./superseded/) | 已有替代规则，保留历史与替代链接 |

日期不随移动改变；部分迁移不能宣布整份旧决定失效。五节格式、命名及历史兼容规则由[文档结构](../documentation-structure.md#决策记录)定义。[写 ADR](../cookbook/add-adr.md)提供操作步骤。

备选方案写真实弃案与放弃理由，不用「没有其他方案」填空。验证写可观察命令、结果与边界，不用「已完成」代替证据。

## 如何检索

从契约名、模块名、类型或失败语义搜索 accepted 与 superseded，再按需看 proposed。例如在仓库根运行：

```text
git grep -n "CandidateRun" -- docs/decisions/accepted docs/decisions/superseded
git grep -n "Session" -- docs/decisions/proposed
```

检索是为避免重复弃案，不维护全局 ADR INDEX 或第二套 notes。规则与事实只链接到其归宿，不在 ADR 全文双写。
