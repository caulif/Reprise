# 恢复后选择候选产品与模型

状态：计划。设计稿见 [candidate-model-picker.html](./candidate-model-picker.html)。落地时改 [tui.md](../product/tui.md)、[product-plugin-compatibility.md](../architecture/product-plugin-compatibility.md) 并补 `docs/decisions/accepted/`；本文不覆盖当前产品规范。

历史会话属于某个 Agent 产品，恢复也必须用该产品的 Pack（发现、冻结、recovery playbook）。恢复得到的是隔离工作区上的任务，不要求候选 Runtime 与来源产品相同。当前 TUI 从 `TaskCase.source.productId` 取 Pack 的 `defaultCandidate()`，开跑前不能换产品，也不能换模型。

## 1. 当前事实

- 内部 Agent 走 Pi。候选必须由目标 Runtime 解析，不能从 Pi 列表推断。见 [tui.md §2](../product/tui.md#2-两类模型)。
- Intake 先选产品再发现会话；冻结后的 `source.productId` 解释「这条历史从哪来」，不自动等于「这次用谁跑」。
- `CandidateSpec` 已有独立的 `productId` 与 `requestedModel`。应用层仍用 `findProductPack(taskCase.source.productId)` 填候选，两套身份被绑死。
- 各 Pack 的 Runtime 适配器已有产品私有 `listModels`，不在 [`RuntimePort`](../../src/core/runtime.ts) 上。
- 恢复完成后进入确认页。Enter 才创建隔离副本并启动 Runtime。候选配置只写本次隔离环境，不改用户全局 `~/.codex` / `~/.claude`。

## 2. 两套身份

| 身份 | 字段 | 谁决定 | 可否在开跑前改 |
|---|---|---|---|
| 来源 | `TaskCase.source.productId` | 冻结会话的 Pack | 否。恢复已按该 Pack 做完 |
| 候选 | `CandidateSpec.productId` + `requestedModel` | 恢复成功后的选择 | 是。来自已注册 Pack 列表 |

恢复、会话解析、playbook 继续只走来源 Pack。预检、隔离注入、启动 Runtime、事件规范化走**所选候选 Pack**。TUI 和应用层禁止按产品名写分支；只遍历 `productPacks`，对选中项调用 `pack.runtime`。

跨产品跑的是同一份恢复后的工作区与同一条 `initialInput`。来源产品的技能文件、钩子、全局配置不自动迁到候选产品。确认页写明来源产品与候选产品，不把跨产品说成「同一 Runtime 复现」。

## 3. 扩展点：插件读目录，Harness 只认一份契约

读模型是 **Product Pack** 的产品私有工作。统一接口加在 [`RuntimePort`](../../src/core/runtime.ts)。每个 Pack 的 `runtime` 实现它。新 Agent 插件实现同一方法后，选产品页多一行、选模页不用改。

```ts
type RuntimeModelOffer = {
  value: string;          // 写入 CandidateSpec.requestedModel
  displayName: string;
  resolvedModel?: string;
};

interface RuntimePort {
  listCatalog(): Promise<readonly RuntimeModelOffer[]>;
}
```

| 层 | 职责 |
|---|---|
| `src/core/runtime.ts` | `RuntimeModelOffer` 与 `listCatalog` |
| `src/products/index.ts` | 已注册 Pack 列表，即选产品页的数据源 |
| Codex / Claude `runtime-port.ts` | 用现有 `listModels` 填 `RuntimeModelOffer` |
| TUI / application | 选产品：`productPacks`；选模型：`pack.runtime.listCatalog()` |

`ProductPack.defaultCandidate()` 只作用于**该 Pack 被选为候选之后**的模型光标：`requestedModel` 在目录里则选中，否则第一项。不用来源会话的 `model` 字段。

## 4. 交互

恢复结束（已恢复 / 部分恢复且可开跑）之后、确认页之前，连续两页选择。无法恢复仍停在确认页，禁止进入。

两页都是**选择**，不是计费确认。隔离、计费、启动仍只在确认页 Enter。

```text
选会话产品 → 选会话 → 冻结 → 恢复
  → 选候选产品 → 选候选模型 → 确认开跑 → 隔离并启动
```

### 4.1 选候选产品

列出静态注册的 `productPacks`（与 Intake 产品页同一集合）。光标默认来源 Pack。每行：显示名、来源则标「来源会话」、`inspectAvailability` 的短状态（未安装不删行）。

Enter 记下 `candidate.productId`，进入选模型。`b` 回恢复摘要。换产品时丢掉上一轮模型选择。

### 4.2 选候选模型

对选中 Pack 调 `listCatalog()`。目录通常几项。↑↓，Enter。加载中问该 Pack 的 Runtime。失败或空目录：Enter 不可用，`b` 回选产品。

第一版不另开 effort / 1M 控件。

### 4.3 确认页

展示来源产品、候选产品、`requestedModel` 与解析名。二者不同时用一句话说明：对照的是恢复后的同一任务，候选是另一套 Runtime。`b` 回选模型。

## 5. 候选写入

```text
CandidateSpec.candidateId   = {productId}-{safe(value)}
CandidateSpec.productId     = 选中 Pack
CandidateSpec.requestedModel = 选中 value
```

`createCodexExperimentWorkflow` 的 resolve 改为：候选 Pack = `findProductPack(candidate.productId)`，禁止再用来源 `productId` 覆盖用户选择。`start` / 候选 preflight 注入所选 Pack 的 `runtime`。`recover` 仍用来源 Pack。

选择只进即将创建的 `RunAttempt` / 隔离配置。不写用户全局配置，不改已结束实验的 manifest，不改 `TaskCase.source`。

确认页再 `validateCandidate`。失败留在确认页，不启动。

## 6. 代码改动面

| 位置 | 改动 |
|---|---|
| `src/core/runtime.ts` | `RuntimeModelOffer`、`listCatalog()` |
| Codex / Claude `runtime-port.ts` | 实现 `listCatalog` |
| `src/application/tui-workflow.ts` | 候选 Runtime 跟 `CandidateSpec.productId`，恢复跟 `source.productId` |
| `src/tui/pages/run.ts` | `renderCandidateProductPicker`、`renderCandidatePicker` |
| `src/tui/controller-*.ts`、`view-projection.ts` | page `candidate-product`、`candidate-model` |
| `docs/product/tui.md` | 最短路径：恢复后可选候选产品与模型 |
| `docs/tui-audit/frames/` | 选产品 / 选模型 / 跨产品确认 / 窄帧 / 失败帧 |

测试：来源 Codex 可选 Claude 并写入 `candidate.productId === 'claude-code'`；模型目录来自候选 Pack 而非来源 Pack；Pi 模型不出现；目录失败不能 Enter；确认页仍是唯一启动点；`TaskCase.source.productId` 不变。反向：恢复成功后未选择就按来源 Pack 默认静默开跑，测试红。假 Pack 出现在选产品页，其 `listCatalog` 出现在选模页。

## 7. 验收

恢复成功后能先选已注册产品、再选该 Pack 目录中的模型。跨产品时确认页同时展示来源与候选。列表不是 Pi 模型。未改本机全局 Agent 配置。无法恢复时到不了这两页。新 Pack 注册进 `productPacks` 并实现 `listCatalog` 即可出现在这两页。
