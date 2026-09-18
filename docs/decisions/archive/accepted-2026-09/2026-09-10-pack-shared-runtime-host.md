# 决策：内置 Pack 共享进程与 Session 文件宿主

状态：accepted

延续 [候选链模块目录](./2026-09-10-candidate-chain-module-layout.md)。

## 问题

Claude Code 与 Codex 各自实现同一份 Runtime/History 契约，进程生命周期、超时停止、Session 文件摘要装配和 turn wait 在两个 Pack 中重复。jscpd 把这些克隆标为门禁噪音。产品协议解析与用户可见 Projection 必须留在 Pack 内。

## 决定

`src/products/shared/runtime-host.ts` 提供可用性探测、catalog TTL 缓存、隔离工作区校验和可执行文件发现包装。`src/products/shared/turn-wait.ts` 提供 turn settlement 队列与消息身份校验。`src/products/shared/session-summaries.ts` 提供 listing 摘要字段装配与后续用户摘要压缩。进程强制关闭在 `src/infrastructure/process/terminate.ts` 的 `forceCloseRuntimeProcess`。各 Pack 的 `protocol.ts` 与 `projection.ts` 不进入共享模块。不合并 catalog 分页或 JSONL 行消费，因为那些绑定产品协议。

仓库根的 `audit-root/` 与 `unused/` 不是受控材料：前者只是 TUI 审计脚本里的假 `experimentRoot` 标签，后者是本机 dataDir 残留。两者加入 `.gitignore`，不进入版本控制。

## 备选方案

**继续在两个 Pack 复制宿主逻辑。** jscpd 棘轮无法下调，后续改超时或摘要字段必须改两处。

**把协议解析一并抽到 shared。** 产品私有帧会泄漏到公共模块，违反 Pack 边界。

## 影响

内置 Pack 的 runtime/runner/sessions 调用共享宿主；产品私有 RPC/JSONL 仍在 Pack。jscpd 剩余克隆应来自文件内部重复或产品协议，而不是成对的 lifecycle 拷贝。

## 验证

`test/products/pack-shared-host.test.ts` 覆盖 TTL 缓存、可用性映射、TurnWaiter、摘要装配与已退出进程的 `forceCloseRuntimeProcess`。`test/core/architecture.test.ts` 要求上述 shared 文件存在，且 `products/shared` 不导入 Pack `protocol`/`projection`。`npm run jscpd` 与 `npm run check` 必须通过。
