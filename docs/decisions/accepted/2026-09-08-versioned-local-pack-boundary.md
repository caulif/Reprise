# 决策：版本化本地 Pack 边界

状态：accepted

目标批次见 [M6.3](../../plan/reprise-refactoring-execution.md#m63-版本化本地插件边界)。

## 问题

内置 Pack 与测试注入走不同入口。契约强制每个 Pack 同时具备 import 与 runtime。外部模块没有显式配置、API major 或诊断，缺包会与历史只读绑在一起。

## 决定

- 公共 Pack API 是 `reprise/pack-api`（`ProductPack` 与 `PACK_API_MAJOR`）。不把宿主内部模块当作插件面。
- Manifest 含 `apiMajor` 与 `capabilities`（`import` | `runtime`）。能力与导出必须匹配；产品安装、认证和模型目录按所需能力检查。
- `{dataDir}/plugins.json`（`schemaVersion: 1`）列出相对 dataDir 的 `module` 或包名 `package`。只加载 JavaScript / 已编译输出 / 已安装包；拒绝原始 `.ts`。不下载、不热加载。
- 内置与外部走同一 `assembleProductPacks`。重复 `productId` 保留先注册者并记诊断，不静默替换。导出错误、major 不符、加载失败逐条诊断，不推翻已接受的 Pack。
- 历史只读不加载 Pack。组装失败不能阻止无关 `history` / `events`。插件与宿主同进程，不承诺隔离挂起或恶意代码。

## 备选方案

**每个 Pack 必须同时 import 与 runtime。** 无法装纯导入或纯候选插件，认证与目录会误阻塞导入。

**测试注入宿主私有对象代替配置加载。** 无法证明真实模块入口；第三 Pack 验证留给后续批次用配置完成。

**TCP 或远程市场。** 超出本机可信边界。

## 影响

CLI/TUI 在组装时加载 dataDir 配置。查询 `products` 返回 `diagnostics`。新增 Runtime 端口字段仍先改 `RuntimePort` 再改内置 Pack。

## 验证

`test/product-registry.test.ts`：重复身份、错误 major、错误导出、原始 TS、能力不匹配、import-only / runtime-only、缺模块仍可读 history。`test/product-contract.test.ts`：Codex 与 Claude Code 仍为双能力。反向：静默替换重复 `productId`、执行 `.ts`、或缺模块阻止 `listHistoryPage` 则红。
