# 决策：可选历史终稿提取端口

状态：accepted

延续 [ProductPack 历史、Runtime 与投影端口](./2026-09-09-product-pack-ports.md)。

## 问题

比较与 TUI 需要历史任务的最终交付字节，但这些字节往往只存在于产品私有 transcript 的补丁/写入工具记录中。若在 Application 按 `productId` 解析 Codex/Claude 私有语法，会破坏 Pack 边界；若把可选能力做成所有插件的硬门槛，第三方 Pack 无法加载。

## 决定

在 `ProductHistoryReader` 上增加**可选**方法 `extractHistoricalArtifacts`。输入为 Host 已冻结/脱敏的 transcript、historicalEvents 与可选 historical cwd 线索；输出为 `HistoricalArtifactManifest`（schemaVersion 1，经 `Value.Check`）与配对字节（manifest JSON 不含 base64）。内置 Codex/Claude Pack 实现确定性解码：只应用有成功结果佐证的写入；静态 `apply_patch` 与 Claude Write/Edit；拒绝 `eval`、动态拼接与未知 shell 改写下的假 final。公共 schema 位于 `src/core/schemas/historical-artifacts.ts`。`PACK_API_MAJOR` 不变；registry 仍只硬性检查 discover/inspect/import。

## 备选方案

**Application 直接解析 Codex 补丁。** 违反「产品解析在 Pack」，且无法扩展到其他产品。

**新增必选 Pack capability。** 迫使未实现的第三方 Pack 加载失败，超出本批范围。

**执行历史 JS/shell 回放。** 不安全，且无法在测试中默认关闭外部费用与副作用。

## 影响

未实现该方法的 Pack 继续可加载；Host 在后续封存/比较路径（B2+）将缺失记为 `capability_unavailable` 类缺口。提取结果的落盘与 Case 接线不在本决定范围。

## 验证

`test/products/historical-artifacts-extract.test.ts`（Add/Update/Delete、未知 shell、路径拒绝、静态 exec 包装、Claude Write/Edit、第三方缺方法）；`test/core/architecture.test.ts`（schema 导出与可选方法签名）；`npm run check`。
