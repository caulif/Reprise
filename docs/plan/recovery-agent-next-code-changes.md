# Recovery Agent 后续代码修改清单

状态：proposed

本文是当前代码审查后的执行清单，承接[Recovery Agent 模块重构实施计划](./recovery-agent-refactor.md)和[大仓库按需恢复计划](./recovery-large-repository-refactor.md)。

## 已完成基础

当前代码已支持超预算源目录的 sparse workspace、只读 `source/`、七个通用工具、单 Session 三轮 prompt、两态结果、机械 Provider 检查、临时记录清理和 baseline 复用。先前 build、Recovery 相关测试和 check 已通过。

## 必须修改

### 1. 完成 envelope

在 Agent、schema、持久化、场景、CLI/TUI 和测试中加入 `summary`：

```json
{"status":"ready"|"blocked","summary":"一句话，最多 240 字符","reportPath":"recovery.md","unresolved":[]}
```

最后一轮同时写报告和 summary，不增加 LLM 调用；Host 不改写文字。`blocked` 的 unresolved 非空，ready 可保留不影响任务的问题。测试空 summary、超长 summary、多句 summary 和状态约束。

### 2. 核查 source 写保护

验证 source 可读、可复制到 workspace，删除/编辑/切换 cwd 后写 source 均拒绝；覆盖变量、别名、相对路径、junction 和 PowerShell 变体。shell cwd 始终是 workspace。

### 3. 保持 seed 同构

`copied`、`sparse`、`checkpoint` 只是 Provider 物化优化，必须进入同一 Session、三轮 prompt、七工具、两态输出和封存流程，不得绕过 Agent 判断。

### 4. 清理旧状态生成

生产路径不得新生成 `partial`、`insufficient_evidence`、`current_state_fallback` 或 `recovered_partial`。历史 baseline 可只读兼容，但不能扩散旧值。增加架构反向测试。

### 5. 明确失败重试

模型传输/结构化失败保留同一 Session 和 workspace 继续；workspace 损坏才丢弃并从 Turn 1 重启。检查 `run-model.ts` 的 reset、release 和三轮游标，分别测试机械反馈续跑和真正重启。

### 6. 增加 G1 风格 fixture

覆盖超预算大目录、深层任务文件、后继成果、需恢复旧文件和可重建依赖；确认 Agent 仍启动、按需读取 source、在预算内封存，关键输入缺失时由 Agent 返回 blocked。

### 7. 统一多类型流程

代码、文档、表格、幻灯片、媒体和调研任务共用同一 RecoveryAgentPort、三轮 prompt、七工具和封存流程；Git 仅为辅助材料，不按任务类型或 Git 有无分流。

## 不应做的修改

- 不增加第四个 turn、摘要/报告 Agent、Todo/Plan/Goal 工具或专用复制工具；
- 不恢复多候选、证据排名、业务 Verifier 或预检查门；
- 不因零变更、源目录总量或无关目录不可复制而否决 ready；
- 不让 shell cwd 指向用户源目录；
- 不把 `.reprise/recovery-work/` 封存进 baseline；
- 不让 Host 重写 Agent summary 或报告。

## 实施顺序与完成条件

按顺序执行：summary 协议 → source 写保护 → seed 同构与失败重试 → 旧状态清理 → G1 fixture → 有/无 Git 同构测试。每次源码修改后先 `npm run build`，再运行相关 `dist/test`；阶段结束运行 `npm run check`。完成条件是所有任务共用流程、大仓库不阻止 Agent 启动、source/workspace 边界可验证、summary/报告/两态结果/复用/重试均有测试证据，生产路径不生成旧状态。
