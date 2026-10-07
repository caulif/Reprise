# 决策：Comparison 核稿提示使用共享执行顺序与明确变体

状态：accepted

## 问题

核稿提示将同一组任务覆盖、证据范围、修稿、检查和预览要求散布在多个段落中，运行入口又重复追加指令。Delivered 和 formal 变体通过完整句子的字符串替换派生，基础句子变化可能静默失去变体差异。真实中止后仍需要模型实际修稿与检查，重复强调要求不证明这些动作已经执行。

## 决定

- 用共享 `COMPARISON_REVIEW_STEPS` 按实际执行顺序组织核稿：核对任务级选择，逐项匹配质量与推荐依据，核对实际输出链和反证，协调主文与折叠依据，遵守篇幅，使用修稿工具批量提交。语义义务不以重复次数表示。
- 用明确 `COMPARISON_REVIEW_VARIANTS` 尾段区分 legacy、delivered、formal，不再通过句子 `.replace` 派生。Legacy 读取并检查实际稿后预览；delivered 使用已送全文，仅在版本变化后重查；formal 将 checkpoint 当材料，要求本次完整 audit 后的新正式当前检查，由 Host 随后的 preview-only closure 收尾。旧检查、口头承诺和意图不成为认证。
- 保留历史问题身份、所有 findingDispositions 与精确 decisionBasis、conclusionScope、双侧 supportBoundary、checked/unchecked 实例范围及 downstream 关系核对。局部 target/self-check 或声明的 delivered_output 不证明最终关系；未支持关系与反证必须影响主文的任务判断，不能靠相邻全局免责声明或删除保证隐藏。
- 保留过程与版本证据边界、sealed final、具体修改与含义变化、renderCheckHistory 的 hash/时间与不同采样相位、实际图片交付和视觉核验区别、Comparison 检查不能冒充原 Runtime 验证。每次仍核对当前 Host 指标双侧方向，未知不作零、估算不作账单，不从耗时推费用或继承旧报告价格。
- 保留单差异 250、多差异 600 的合并主文字数，以及 400/1000 的折叠解释限制和 Host 验证引用例外。不得为篇幅删除独立决定性质量；主文与 details 标题、段落、限制一致，不重复 Host 指标或结论。允许条件或未决结果，不强制赢家、固定过程栏目或无限调查。
- 运行入口只补实际 source-pass 终止事实、材料入口和对应变体，不再次复制 formal 收尾要求；修复轮只带当前失败条件及该变体尾段，先前实际核稿要求仍在同 Session 输入中。作者接受草稿后停止生成，由 Host 进入独立核稿，作者不预览。

这次仅整理模型可见指令与对应快照，不改变工具 Schema、状态机、typed yield、正式检查和发布绑定，不调整模型、effort、maxTokens、请求、费用或时间预算，不包含原例答案或任务词表。实际输入仍经既有 generation snapshot 重建。

## 备选方案

**继续向现有长提示追加更多警告。** 会进一步重复义务，不能证明修稿动作发生，也增加变体之间的漂移。

**只缩短字数而删除语义义务。** 会弱化独立关系、反证、重要未知或正式核稿绑定；选择去重和明确执行顺序，保留义务。

**沿用全文字符串替换。** 依赖旧句子的精确字节，未命中也不会报错；明确共享数组与变体尾段使差异可直接审查和快照验证。

## 影响

三种核稿提示共享任务判断契约，具体读取和收尾方式各自明确。提示更短不等于调用更短、发现反例更完整或判断更正确；真实报告的输出链、关键差异和全文语义仍需单独验收。Formal 变体仍必须实际新检查，预览仍只能在既有 closure 执行。

## 验证

更新 legacy、delivered、formal 和 compose 快照。保留实际 phase/input 测试对 source 中断、重要未知、材料交付、新正式检查、preview-only closure、修复版本和失败优先的断言；读取入口 `Now inspect`/`Now audit` 与修复入口保持，不用删断言适配文字重排。源码先 build，再由统一门禁执行 compiled focused tests 和 `npm run check`；真实模型和布局验证仍需新终态报告 hash，不复用失败运行或旧报告。
