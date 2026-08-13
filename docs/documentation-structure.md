# 文档结构与路径约定

本文说明 `docs/` 中的文档用途、权威性、命名和迁移规则。目标是让读者和 Coding Agent 仅凭路径判断一份文档是否能够约束当前实现。

## 目录模型

```text
docs/
├── README.md
├── documentation-structure.md
├── development-plan.md              # 模块顺序、退出条件与阶段闸门
├── project-architecture.html        # 只读可视化入口，不拥有独立语义
├── product/
│   ├── overview.md                  # 产品目标、用户价值和非目标
│   └── tui.md                       # 最短用户路径和信息层级
├── architecture/
│   ├── overview.md                  # 跨模块唯一主设计
│   ├── technology-selection.md
│   ├── persistence-and-crash-consistency.md
│   ├── product-plugin-compatibility.md
│   ├── controller.md
│   ├── controller-experiment-conditions.md
│   ├── environment.md
│   ├── comparison.md
│   ├── run-outcome.md
│   └── validation.md
├── research/                        # 理论、调研和备选方案，非规范性
└── archive/YYYY-MM-DD/              # 被替代的历史材料，非规范性
    └── drafts/
```

目录模型列出当前活跃规范；新增或移动文件时必须同步本节和 `docs/README.md`。

## 权威与冲突

| 问题 | 唯一来源 |
|---|---|
| 产品为什么存在、服务谁、明确不做什么 | `product/` |
| 跨模块术语、公共协议、所有权和生命周期 | `architecture/overview.md` |
| 单模块如何细化公共协议 | 对应 `architecture/` 专题 |
| 实现顺序、模块交付物、退出条件和阶段闸门 | `development-plan.md` |
| 为什么这样设计、有哪些备选方案 | `research/`，非规范性 |
| 被替代的讨论和过程记录 | `archive/`，非规范性 |

专题文档不得重新定义架构总览的公共类型。HTML 只能同步展示 Markdown，不得重新编号或拥有不同验收条件。发现冲突时修改产生冲突的活跃文档，或归档已经失效的材料；不以最新修改时间判断权威性。

## 放置与命名规则

- 文件和目录使用小写英文 `kebab-case`；入口文件 `README.md` 是唯一例外；日期目录使用 `YYYY-MM-DD`。
- 每个主题只保留一个当前来源，不在多个目录复制相同规范。
- 文件名描述稳定主题，不使用 `final`、`new`、`latest` 或版本号；版本号只用于确需追溯的归档草稿。
- 不为尚未发生的扩展创建空目录、空接口或占位文档。
- Product Pack 是叙述术语；公共代码接口仍可命名为 `AgentProductPlugin`。

## 链接规则

- Markdown 使用相对链接，例如 `../architecture/overview.md`。
- 链接到文件本身，不硬编码旧工作区绝对路径。
- 移动文件时同时检查所有入站和出站链接。
- 归档文档可以保留历史文字，但其可点击链接不能指向不存在的路径。
- `docs/README.md` 只负责导航，不复制专题内容。

## 迁移规则

文档被替代时：

1. 确认当前唯一来源；
2. 将旧文档移入 `archive/YYYY-MM-DD/`；
3. 在归档目录入口说明非规范性和归档原因；
4. 更新当前文档和导航链接；
5. 检查 Markdown 相对链接；
6. 内容完全相同的副本经 hash 确认后只保留一份。

当前不建立正式 `decisions/` 目录。只有出现难以从当前规范理解、且会长期约束实现的不可逆决策时，才采用“一项决策一个文件”的轻量 ADR，避免把阶段性讨论升级为制度。
