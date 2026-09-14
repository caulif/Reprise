# 决策：门禁分层为 fast / check / full

状态：accepted

## 问题

默认 `npm run check` 把 TUI 帧、jscpd、knip 与源码体积和 build/test 绑在一起，日常改协议的固定成本过高。直接删检查会失去自动入口。

## 决定

`scripts/run-gates.mjs` 增加 `fast` 与 `full`。`fast` 含 build、typecheck、lint、test、layer imports、secret scan；lint 在 fast 里是因为 `tsc` 不执行 ESLint。`check` 与 `full` 共用同一份 `CHECK_IDS`：这是迁移重叠，不是「full 更严」。旧门禁不在重叠期删除。`npm run check:fast` / `check:full` 为自动命令。

## 备选方案

**立刻把 TUI 帧移出 check。** 会改变默认合并门，超出本轮兼容要求。

**只写文档让人记着跑子集。** 没有自动入口。

## 影响

日常迭代可跑 `check:fast`。声称重构完成仍跑 `check`。在 TUI 帧、jscpd、knip 移出默认入口之前，不要把 `check:full` 当成更严的门。CI workflow 暂不改为 fast。

## 验证

`node scripts/run-gates.mjs nosuch` 非 0。`fast` 模式 id 含 `lint` 与 `verify:secrets`，且不含 `knip`。反向：`fast` 缺 `lint` 或含 `knip` 时 `run-gates.mjs` 在选中该 mode 时抛错。
