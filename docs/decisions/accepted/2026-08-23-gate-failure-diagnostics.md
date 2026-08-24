# 决策：门禁失败必须输出可复现诊断

状态：accepted

## 问题

`scripts/run-gates.mjs` 在子进程 `error` 时只返回失败，汇总只打印 gate 标签。CI 或贡献者看到 `FAIL` 后无法从日志直接得到命令、退出码/信号、Node/OS 和 git SHA，只能凭猜测本地重跑。脚本里还有从未配置的 `allowFailure` 分支，容易让人以为存在非阻断门禁。

## 决定

每个失败 gate 必须打印：gate id、完整命令、退出码或 spawn 错误、signal、Node 版本、OS、git SHA。stderr 仍随 `stdio: inherit` 保留。没有任何 gate 使用非阻断失败；脚本不提供 `allowFailure`。Windows 上 `npm` 通过 `npm.cmd` 启动，且 `shell: false`，避免 `shell: true` + args 触发 DEP0190。`run-gates.mjs` 在编排前跑自检：非 0 退出、spawn 失败、带空格参数，以及 Windows 上 `npm.cmd`。

## 备选方案

**只把退出码写进汇总行。** 贡献者仍不知道命令和环境，跨机器复现不够。

**保留 `allowFailure` 供将来诊断门禁使用。** 没有 owner 和失效日期的非阻断开关会变成永久假绿。需要观察项时另开带复评日期的任务，不预留死分支。

**失败时上传未脱敏的完整日志目录。** 诊断文本已够本地复现；把 prompt、路径和 secret 打进 artifact 违反凭据规则。

## 影响

- 本地 `npm run check` 与 CI 失败日志变长，但可按 id 和命令直接重跑。
- 以后若要加非阻断检查，必须先写 decision，不能默默加回 `allowFailure`。

## 验证

- `node scripts/run-gates.mjs --self-test` 故意让一个命令以非 0 退出、并触发一次 spawn 失败，输出中含 gate id、command、exit 或 spawn error、node、os、git。
- 干净编排路径不打印 `NON-BLOCKING`。
