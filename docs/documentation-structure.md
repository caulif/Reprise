# 文档结构

写作与维护规则见[贡献指南](./CONTRIBUTING.md#文档维护)；本文只维护目录模型和受控边界，供文档检查使用。

## 目录模型

```text
docs/
├── architecture/           # 当前架构，四个按任务划分的专题
├── decisions/              # 选择理由和历史，不是日常必读
├── plan/                   # 仅保留 archive 历史计划
└── tui-audit/frames/        # Windows 门禁快照，非阅读材料
```

顶层以 README 导航到 usage、development、roadmap，以及必要社区政策。目录模型不列每一份文件，新增或删除目录时同步本文与 .gitignore。

## 受控边界

当前说明、社区政策、决策记录、plan/archive 历史计划和 TUI frames 受版本控制。本机讨论、实验、截图与第三方缓存留在 Git 忽略的 docs/.local 等产物目录；公开文档不能链接或依赖这些文件。docs/local 是旧误拼目录，新增本地材料只用 .local。

## 权威与冲突

使用指南描述用户行为；架构描述实际所有权、不变量与失败语义；路线图描述开放目标与缺失证据；代码和配置拥有具体字段、工具、prompt、依赖及 CI 矩阵。文档与实现冲突需依据目标、调用链和复现结果判断，不能仅按日期或目录认定其中一方必然正确。

## 决策记录

决策格式和状态解释见[ADR 指南](./decisions/README.md)。历史目录只用于追溯；accepted 表示当时接受过，不保证全部条款今天仍有效。明确全部或部分替代关系，不把旧正文改写成相反结论。

## 放置与命名规则

使用小写 kebab-case；README、AGENTS 和 GitHub 社区文件名为例外。ADR 用日期加主题命名；当前说明不加 final、latest 或版本后缀。

## 链接规则

仓库文件使用相对 Markdown 链接和真实锚点，不写本机绝对路径。迁移同时更新引用及生成目标，不保留大量空跳转页。文档链接、目录、预算与格式由 `npm run verify:docs` 检查。
