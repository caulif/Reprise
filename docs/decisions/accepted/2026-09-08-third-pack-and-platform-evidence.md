# 决策：第三 Pack 配置入口与平台证据分层

状态：accepted

目标批次见 [M6.4](../../plan/reprise-refactoring-execution.md#m64-独立第三-pack-与平台证明)。

## 问题

假产品素材只被测试直接 import，或注入 TUI/workflow 的 `packs`/`pack`。无法证明「只加包与 `plugins.json`、宿主不变」即可发现、导入、模拟候选和展示活动。公共 `pack-api` 也未从打包产物解析。三平台终端与真实 Runtime 证据容易与 CI 模拟混为一谈。

## 决定

- 第三测试 Pack 是 `test/fixtures/fake-pack` 编译产物，以 `reprise-third-pack` 安装到 dataDir `node_modules`，经 `{dataDir}/plugins.json` 的 `package` 入口加载。证明测试不向 TUI/workflow 注入 Pack 对象。
- 发现、导入、`listCatalog`/`validateCandidate`、活动翻译与 facts、CLI `products`、TUI 产品列表均走组装后的 registry。内置 Pack 仍由同一契约套件覆盖。
- `reprise/pack-api` 从 `dist/src/products/contract.js` 解析；`npm pack` 含该文件、不含 `src/`。
- 平台证据分三类，互不顶替：CI 三 OS 模拟；Windows TUI 帧与假终端；真实 Runtime smoke 仅显式 opt-in。缺少 macOS/Linux 真终端 IME/滚轮/拖选时记缺口，不自行产生费用。

## 备选方案

**测试继续 `packs: [fakeProductPack]`。** 绕开插件 API，不能证明配置入口。

**在 CI 默认跑真实 Codex/Claude。** 产生费用，违反 opt-in。

## 影响

TUI 单测仍可用注入的 session 适配器隔离发现逻辑。第三 Pack 闭环以配置加载为准。

## 验证

`test/third-pack-config.test.ts`：安装包 + `plugins.json` 后发现、导入、目录、活动、CLI、TUI。`test/pack-api-resolve.test.ts`：dist 导出与 pack 清单。`test/architecture.test.ts`：证明测试不含 `packs: [` 与 workflow pack 注入。反向：证明测试注入 `packs: []` 或 pack-api 从 `src/` 解析则红。
