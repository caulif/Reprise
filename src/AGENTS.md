# AGENTS.md — 代码层

依赖只能向下：`cli` → `tui` → `application` → `infrastructure` / `products` / `environment` / `agents` / `report` → `core`。禁止反向 import。

`products/packs/` 下每个 Pack 必须实现同一份 [`contract.ts`](products/contract.ts)，不在 Pack 外复制产品私有类型。本地 Pack 经 `{dataDir}/plugins.json` 由 [`registry.ts`](products/registry.ts) 组装；公共类型从 `reprise/pack-api` 解析。应用层与 TUI 不按 `productId` 分支。

`tui/pages/` 只做渲染，不写业务判断、不发请求、不改实验状态。

原子写一律用 [`writeAtomic`](core/identity.ts)，不要再写一份 rename 封装。
