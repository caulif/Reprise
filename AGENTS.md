# AGENTS.md

默认只读 product/ 与 architecture/ 等事实层；ADR 仅在触及跨模块契约或门禁时再按需检索 [decisions/README](docs/decisions/README.md)。

改代码后跑 `npm run check`（[门禁](docs/development.md)）。只改文档跑 `npm run verify:docs`。不要为一次改动默认跑全套。新增或修改门禁时，同一次变更必须附一个能让该门禁失败的自动化用例（[反向用例](docs/decisions/accepted/2026-08-15-gate-reverse-tests.md)）。覆盖率阈值只能升不能降（[覆盖率](docs/decisions/accepted/2026-08-14-coverage-thresholds.md)）。

测试读的是 `dist/`。改完源码必须先 `npm run build`；`node --test` 直接跑 `.ts` 不成立（[`package.json`](package.json)）。

新增 Runtime 能力先改 `src/core/runtime.ts` 端口，再改内置 Pack；不在应用层判断产品类型（[平台与 Pack](docs/architecture/overview.md)）。

持久化、模型输出、外部 JSON 的读写必须过 `src/core/schema.ts` 的 `Value.Check`；同进程内的类型化边界不加运行时校验（[持久化](docs/architecture/evidence-and-comparison.md)）。

CandidateRun 状态变化只能过 `src/core/state-machine.ts` 的 `assertTransition`（[结果](docs/architecture/execution.md)）。

进入模型请求的输入必须能从事件日志复原（压缩后试卷是 summary + retained tail，见 `agent.context_compacted`）；新增模型可见输入必须新增事件（[持久化](docs/architecture/evidence-and-comparison.md)）。

TUI 是事件日志的只读投影，不持有实验状态机，不伪造未公开的推理过程（[TUI](docs/usage.md)）。

模型服务 API 密钥可存于本机且 Git 忽略的 `.reprise/harness-model.json`；官方目录登录只在 Pi `auth.json`。不得提交、打印、复制到事件、artifact 或报告；不读也不保存 Codex CLI 凭据（[凭据](docs/usage.md#边界)）。

真实 Runtime 调用必须显式 opt-in（环境变量），默认路径不产生外部费用（[smoke](docs/development.md)）。

双重防线：测试证明当下没坏；ADR 防止以后重复错决策。跨模块协议、on-disk、提示词契约、工具面、架构边界或工程流程变化，同批新增或更新 ADR；无契约变化的小修豁免（[触发与检索](docs/decisions/README.md)）。

Windows 11 是唯一已验证平台；路径拼接和进程启动按 Windows 优先（`.cmd` 走 `spawnRuntimeProcess`）（[技术选型](docs/architecture/overview.md#pack-边界)）。

不注释代码本身已经说清的事实。空 `catch` 必须写明它吞掉了什么、以及为什么其他情况到不了这里。

未覆盖的行往往是门禁标出的死代码，应当删除，而不是补测试去覆盖。行覆盖率是必要条件，不是充分条件。
