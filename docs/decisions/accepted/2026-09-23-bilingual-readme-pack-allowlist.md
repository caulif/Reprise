# 决策：发布包允许中英文 README

状态：accepted

## 问题

仓库新增 `README.zh-CN.md` 后，npm 打包会包含它，而[发布包门禁](./2026-08-23-supply-chain-and-layer-gates.md)原先只允许 `README.md`。包内容合规却被 `verify:pack` 拒绝。

## 决定

发布包允许名单明确接受根目录的 `README.md` 与 `README.zh-CN.md`。`README.md` 仍是必需文件；中文 README 可选。其他语言、备份或更深目录的 README 不因这次扩展自动放行。新增发布文件仍需单独审查允许名单。

## 备选方案

**放行所有本地化 README。** 使用 `README.*.md` 模式会让未经审查的新语言文件进入发布包，扩大原有允许名单的边界。

## 影响

中英文说明随 npm 包发布；后续增加或重命名 README 时仍需更新允许名单和反向用例。

## 验证

`scripts/verify-pack.mjs` 的自检同时验证中英文 README 可通过，以及 `README.fr.md`、`README.zh-CN.md.bak` 会被拒绝。`npm run check` 包含该自检和真实 `npm pack --dry-run --json` 清单检查。
