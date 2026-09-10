# 决策：ProductPack 历史、Runtime 与投影端口

状态：accepted

延续 [版本化本地 Pack 边界](./2026-09-08-versioned-local-pack-boundary.md) 与 [候选产品与模型选择](./2026-09-02-candidate-product-and-model-picker.md)。目标见 [Application 与候选链重构](../../plan/application-candidate-agent-refactor.md)。

## 问题

Application 需要产品无关端口来发现历史、选择模型和创建候选 Runner。公共 Pack API 仍使用 `sessions` / `RuntimePort` / `activity` 命名，且缺少可校验的 `CandidateLaunchContext`。若保留别名双轨，后续 CandidateRun 与 TUI 会继续依赖两套名字。

## 决定

`reprise/pack-api` 的 `PACK_API_MAJOR` 为 3。投影端口与正式时间线见 [UserVisibleTurn 时间线](./2026-09-10-user-visible-turn-timeline.md)。`ProductPack` 端口是 `history: ProductHistoryReader`、`runtime: ProductRuntime`、`projection: UserSurfaceProjection`。访问函数是 `packHistory`、`packRuntime`、`packProjection`。持久化的候选交接对象是 `CandidateLaunchContext` 与 `CandidateSessionHandle`，读写经过 `Value.Check`。不导出 `SessionSourceAdapter`、`RuntimePort`、`TargetActivityTranslator`、`TargetActivity` 或 `packSessions` / `packActivity`。Application 与 TUI 不导入产品私有实现。

## 备选方案

**保留旧字段并加别名。** 调用方会同时依赖两套名字，计划明确禁止双轨。

**把交接类型只写在 Application 内部。** Pack 创建 Runner 与 Host 准入无法共用同一份可校验事实。

## 影响

本地插件必须声明 `apiMajor: 3`，并同时导出 `history`、`runtime` 与 `projection`。缺任一口径记为 `capability_mismatch`。

## 验证

`test/product-pack-ports.test.ts`、`test/architecture.test.ts`（禁止旧接口名）、`test/pack-api-resolve.test.ts`（`PACK_API_MAJOR === 3`）、`test/product-registry.test.ts`（`apiMajor: 1` 记为 incompatible）。
