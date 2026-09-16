# 决策：Hostedtoolcache 上按平台解析 npm-cli.js

状态：accepted
日期：2026-09-16

## 问题

门禁与 `npm pack`/`npm audit` 经 `node npm-cli.js` 启动，避免 Windows 上对 `npm.cmd` 使用 `shell:true`。解析路径写死为 `dirname(execPath)/node_modules/npm/bin/npm-cli.js`，这是 Windows Node 安装布局。GitHub `actions/setup-node` 在 Ubuntu/macOS 把 npm 放在 `prefix/lib/node_modules/npm`。CI 在 `node` 的 `bin/` 下找 `node_modules/npm/bin/npm-cli.js`，`static`、`test(ubuntu/macos)` 与 coverage 的 pack 检查因此失败。

## 决定

`scripts/npm-cli.mjs` 按顺序解析：当前进程的 `npm_execpath`（仅当 `execPath === process.execPath`）、Windows `node.exe` 旁布局、Unix `lib/node_modules/npm` 布局、与该 `execPath` 同目录的 `npm` shim、当前进程 `PATH` 上的 npm 入口。假节点树自检不得被 `npm run` 注入的 `npm_execpath` 抢先匹配。门禁、`verify-pack`、`verify-audit` 与 pack-api 测试共用该解析。继续用 `node` + `npm-cli.js` + `shell:false`，不改回 `npm.cmd`。

## 备选方案

**只在 workflow 里改 Node 版本或 `cache`。** 不修脚本里的错误布局，本地 nvm 与 hostedtoolcache 仍会分叉。

**POSIX 直接 spawn `npm`，Windows 仍走 npm-cli.js。** 两套启动路径；Windows 自检无法覆盖 Linux CI。

**`shell: true` 调 `npm`。** 与 argv/`shell:false` 技术选型冲突。

## 影响

- 改 npm 启动方式必须更新本决定与 `scripts/npm-cli.mjs` 的反向自检。
- `run-gates` 在所有平台对 `npm -v` 做 self-test，不再只在 Windows 上验证。

## 验证

- `selfTestNpmCli`：假 Windows 树与假 Unix 树都能解析；Unix 树不满足仅 Windows 候选；`npm_execpath` 指向 Unix CLI 时假 Windows 树仍解析到自己的 `npm-cli.js`。
- `node scripts/run-gates.mjs --self-test` 在当前宿主能跑 `npm -v`。
- 反向：候选列表去掉 `lib/node_modules/npm` 时，Unix 假树解析失败或落到错误路径。
