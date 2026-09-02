# 决策：恢复后选择候选产品与模型

状态：accepted

## 问题

历史会话的 `TaskCase.source.productId` 与 `CandidateSpec.productId` 被绑在一起。TUI 用 Pack 的 `defaultCandidate()` 开跑，操作者不能换被测产品或模型。Codex / Claude Code 都能列出本机目录并按请求切换；目录读取是产品私有协议，不应泄漏到 TUI。

## 决定

- 来源身份只解释会话从哪来、用哪个 Pack 做恢复。候选身份在恢复成功后选择，可以是另一个已注册 Pack。
- 模型目录由 Product Pack 的 Runtime 适配器读取。统一契约是 `RuntimePort.listCatalog()` → `RuntimeModelOffer[]`。TUI 只遍历 `productPacks`，不判断产品名。
- 交互：恢复成功 → 选候选产品 → 选候选模型 → 确认开跑。无法恢复不到选择页。确认页仍是唯一启动与计费门。
- 选择只写入本次隔离运行。不改用户全局 Agent 配置，不改 `TaskCase.source`。

## 备选方案

**继续绑死来源 Pack 的 defaultCandidate。** 不能用别的 coding agent 跑同一恢复任务。

**把 `listModels` 直接暴露给 TUI。** 每个新产品都要改 TUI 分支。

**选模型页兼做计费确认。** 与「不要连续多个启动确认」冲突；目录失败时也会像已经同意计费。

## 影响

[TUI 最短路径](../../product/tui.md#32-每次比较)。[Product Pack 兼容性](../../architecture/product-plugin-compatibility.md#5-pack-选择流程) 的候选运行步骤。`CandidateSpec.productId` 决定 Runtime；`recover` 仍用来源 Pack。确认页、运行页顶栏与画布图例用候选 Pack 显示名，不用 `TaskCase.source.productId`。

## 验证

- `test/candidate-picker.test.ts`：目录渲染、跨产品确认、无候选不得开跑、假 Pack `listCatalog`、运行画布用候选产品名。
- `test/codex-intake-flow.test.ts` / `test/codex-intake-commands.test.ts`：恢复成功后经过选产品与选模型才确认。
- `docs/tui-audit/frames/`：`29-candidate-product`、`30-candidate-model`。
