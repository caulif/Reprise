# 文档结构与路径约定

本文定义目录、权威、生命周期和维护边界；[文档指令](./AGENTS.md)定义写作操作，[README](./README.md)是唯一导航。路径必须让贡献者和 coding agent 判断“当前规则”与“目标计划”。

## 目录模型

```text
docs/
├── AGENTS.md                        # 文档层写作指令（不定义规范）
├── README.md                        # 唯一导航入口
├── CONTRIBUTING.md                  # 贡献与本地验证
├── SECURITY.md                      # 漏洞报告
├── CODE_OF_CONDUCT.md               # 行为准则
├── SUPPORT.md                       # 支持边界
├── GOVERNANCE.md                    # 维护与决策方式
├── CHANGELOG.md                     # 用户可见变更
├── release-checklist.md             # 发布前验证与回滚
├── postmortem-template.md           # 事故复盘模板
├── documentation-structure.md       # 本文
├── codex-smoke-gate.md              # 真实计费运行的准入程序与验收记录
├── engineering-gates.md             # 本地与 CI 门禁契约
├── product/                         # 产品目标、用户路径和非目标
├── architecture/                    # 当前跨模块与专题架构规范
├── decisions/                       # 决策记录
│   ├── proposed/
│   ├── accepted/
│   └── superseded/
├── plan/                            # 唯一活跃总计划、目标设计与 task brief
├── progress/MASTER.md               # 稳定进度入口
└── tui-audit/frames/                # TUI 快照基线（受控）
```

目录树只声明目录模型，不复制文件清单。新增或删除受控目录时同步本文、README 和 .gitignore，并运行 npm run verify:docs。根 README 是用户入口，根 AGENTS 是 Agent 常驻索引，专题放在 docs 或对应代码目录。

## 受控边界

product、architecture、decisions、plan、progress 及上列治理文档属于长期受控材料。docs/.local 保存一次性审查和已结束计划，不受控；不得从受控文档链接到它。research 仅允许忽略的本机交互草图，不拥有设计事实，不是开源检出的必需文件。

生成的 HTML、截图和运行记录不受控；tui-audit/frames 是逐字节审计基线例外，受控。HTML 不得拥有独立验收编号；手工原型若只覆盖部分场景，必须标为示例并链接 Markdown，不能声称完整同步。发布说明不依赖本机原型存在。

## 权威与冲突

| 问题 | 唯一归宿 |
|---|---|
| 当前产品目标、用户操作与安全限制 | product/ |
| 当前跨模块语义、所有者与生命周期 | architecture/overview.md；专题只细化本模块 |
| 实际类型、字段、工具注册、prompt、依赖与 CI 矩阵 | 对应代码或配置；文档链接，不维护全文副本 |
| 尚未实施的目标、迁移顺序与验收 | plan/ 的对应主题总计划 |
| 选择理由与替代关系 | decisions/ |
| 当前批次与完成证据 | progress/MASTER.md |
| 贡献与门禁 | CONTRIBUTING.md、engineering-gates.md |
| Agent 常驻指令 | 各层 AGENTS.md，索引规范，不复制规范 |

当前规范描述已存在的边界，目标计划描述经确认要改变的边界，两者不是同一时间范围。任务开始先确定修复当前还是实施目标。文档与代码冲突时标明证据并修正；不能以代码偶然行为自动授权改变产品语义，也不能把目标命令写成已可用能力。用户明确授权优先于仓库工作流偏好。

迁移差异由[规范迁移边界](./plan/documentation-reconciliation-for-session-harness-workflow.md)集中维护，不在每个专题重述目标。AGENTS 保留短入口；不要求每次任务读完全部 ADR。不能按修改日期判断权威。

## 决策记录

路径：decisions/{proposed|accepted|superseded}/YYYY-MM-DD-topic.md。日期为首次提出日期，移动不改日期，不加分类子目录。

proposed 包括未拍板提案，以及已确认但等待实施生效的目标；后者必须在决定中明确确认情况和生效验收。accepted 表示当前生效规则，superseded 表示已有替代规则。设计确认不等于实现完成，不要求重复批准。

文件格式：第一行 # 决策：标题，第三行 状态：proposed|accepted|superseded，与目录一致。正文依次为：

```markdown
## 问题
## 决定
## 备选方案
## 影响
## 验证
```

备选方案每段以粗体名称开头，只记录真实考虑过的取舍。验证写可观察条件，不用“已完成”代替证据。accepted 用现在时。协议、格式、提示词契约、工具面、工程流程或门禁变化须同批新增或更新 ADR；纯机械改动豁免。

不得将旧决定改成相反内容。新决定指向旧记录，旧记录在移入 superseded 时补替代链接并冻结；之后只修断链或元数据，不修改历史理由。部分迁移不能整份宣布旧决定失效，说明仍有效范围。2026-08-23 起的 proposed/accepted 检查五节模板，更早记录保留格式兼容；superseded 不检查模板。

## 防止漂移

每次 PR 明确文档归宿：行为修改同步产品/架构；实际字段或 prompt 改代码源；目标改计划；完成证据只改 MASTER；理由改 ADR。审查者核对代码、规范、失败场景证据，不能仅凭 Agent 总结或截图合并。

稳定知识先复用现有文档，不为单次任务新建总计划。规范写行为、边界与失败语义，不抄完整 TypeScript、prompt 或目录清单。版本与命令引用 package.json、帮助入口和 CI 配置；短使用示例可以保留，但必须实际核对。不固定写个人模型、一次 smoke 成功或本机绝对路径为产品默认值。

门禁检查链接、目录、命名、模板和预算，不证明设计语义一致。每个迁移批次人工复核相关旧术语和承诺，将差异与对应验收一起关闭。定期审查只在发布或迁移收口时进行，不增加无人维护的定时流程或重复台账。

## 放置与命名规则

文件使用小写 kebab-case；README.md、AGENTS.md、progress/MASTER.md 和 GitHub 治理文件名为例外。日期采用 YYYY-MM-DD，不使用 final、latest、new 或版本号命名。一个主题一个权威来源，不创建空目录和占位文档。

## 链接规则

使用相对 Markdown 链接到真实文件和锚点，禁止工作区绝对路径。移动时更新入站、出站链接及导航。受控文档不能链接本机归档或忽略的 HTML；公开读者无需这些文件即可理解设计。

## 迁移规则

先确定唯一新归宿，保留仍有效的不变量，再移动已完成计划到 docs/.local 或已替代 ADR 到 superseded，更新引用并验证。Git 保留历史，不新建 archive 日期树。只为仍有真实入站依赖的路径保留简短重定向，不长期保存空的“兼容入口”。
