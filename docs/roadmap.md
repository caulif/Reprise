# 路线图

这里只保留仍需取得证据或完成实现的目标。三轮 Recovery、连续 Session、线性生命周期和候选隔离运行属于当前实现，不在这里重复列为开放目标。真实模型、Runtime 和终端验证必须显式 opt-in，不能用离线测试替代。

## 开放目标

### 任务起点恢复与首轮指令一致性验证

**要避免的问题：** 候选在尚未提出建议时，不应看到任务后的结果；Controller 开场不应引用候选尚未说过的建议。

**验收：** 在一次经授权且显式 opt-in 的完整 Recovery + Controller 运行中，同时满足：

1. 任务前 baseline 与 Git sink initial 不含历史任务提交或任务后脏文件。
2. 候选收到的开场来自本次事件和用户输入，体现「先分析、先不修改」。

旧 sink、旧轨迹和重渲染卡面都不能替代新证据。记录运行标识、模型、授权范围、baseline、Git sink initial 和实际 opening。内部案例别名：N6。

**贡献入口：** Provider 历史导入、Controller opening 提示词、真实终端授权 smoke 记录。见 [开发指南](./development.md#真实调用与费用) 中的 opt-in 命令。

### 平台与真实 Runtime 证据

补齐 Windows 真终端的真人键盘导航、IME 组字、拖选复制和异常退出恢复证据；为候选 Runtime 启停、取消和非零退出取得授权 smoke 记录；Controller 真实模型 lane 和生产 provider 输入对拍仍需记录模型、工具面、预期、实际结果及失败项。macOS 与 Linux 的同一终端矩阵尚未验证。2026-09-08 的 Windows Terminal 历史观察只覆盖启动、中文渲染与部分鼠标事件进入 ConPTY；不证明真人 IME、选区或剪贴板。Controller 历史评估包含多项 protocol/invalid_output 失败；只读工具夹具的一次合法 done 不能关闭生产工具面的能力验收。

**贡献入口：** `probe:tui-terminal`、`evaluate:controller`、`agent-context-probe` 等脚本在授权环境下的记录与失败项说明。

### Recovery 默认空 staging

将 Recovery 的默认起点改为空 staging，并提供只读 source/observations 挂载；Agent 按需复制需要的文件，保留源目录写保护、链接边界、凭据保护和 staging 预算。当前 `beginRecovery` 对预算内 source 或 checkpoint 仍会复制，只有超预算时使用 sparse。相关实现入口：[local-workspace-provider.ts](../src/environment/local-workspace-provider.ts)。

### 基线复用前条件检查

封存 baseline 被复用前，检查必要的运行条件；缺失时只修补运行副本或本机依赖，不污染已封存起点，也不重新执行完整 Recovery。验收要求：条件正常时不重新调用 Recovery；缺条件时只补必要依赖或运行副本，保持 baseline 的内容与身份不变；记录检查和修补证据，失败时不启动候选。

## 已知实现问题

每项包含用户影响、修复完成条件和当前验证范围。

### 实验身份与配置接纳

- **用户影响：** 同一 experiment ID 的冲突 spec 仍可能被忽略，workflow 可读取后来配置，实验身份与新增 run 的条件缺少完整接纳约束。
- **修复完成条件：** 明确实验身份、允许变化的每次运行条件与拒绝时机，并对同 ID 冲突补一致性回归；不能只依赖进程内对象或操作配置快照。
- **当前验证范围：** 每次操作的有效配置 DTO 已记录实际预算和模型条件，但尚未证明实验身份闭环。已接纳启动的 Runtime 校验/准备失败已有 attempt 与诊断回归；接纳前非法输入、竞争及写入失败的边界见[执行流程](./architecture/execution.md#candidaterun-生命周期)。

修复后应补回归用例，并按变更风险运行构建、相关测试和门禁。

## 验证记录要求

| 开放项 | 取得证据的入口 | 尚不能据此宣称 |
|---|---|---|
| Windows 真终端 | `probe:tui-terminal`，显式 `REPRISE_REAL_TERMINAL=1` 且 stdout 为 TTY；真人执行导航、IME、拖选复制 | 合成 Unicode 或原始鼠标事件不证明 IME／复制成功 |
| Runtime 启停与取消 | 对应真实 runner，经授权与脚本 opt-in；记录非零退出和清理结果 | 无工具协议 smoke 不证明完整任务运行 |
| Controller 能力 | `evaluate:controller`，`REPRISE_REAL_MODEL=1`；记录模型、工具面及每项预期／实际 | fixture 或单样例成功不证明整体能力 |
| 生产输入对拍 | `agent-context-probe`，`REPRISE_AGENT_CONTEXT_PROBE=1`；核对真实 streamFn 与日志重建输入 | 离线重建测试不等于生产 provider 已对拍 |
| macOS/Linux | 在选定终端重复中文输入、IME、缩放、滚轮、复制、取消与历史重开 | CI 模拟矩阵不能替代真实宿主验证 |

命令的当前定义以 [package.json](../package.json) 和对应 [scripts](../scripts/) 为准；费用与执行边界见[开发指南](./development.md#真实调用与费用)。新证据记录日期、环境、命令和未通过项，不以旧报告重渲染关闭验收。

有效配置快照的当前范围和未记录条件见[模型输入可追溯](./architecture/evidence-and-comparison.md#模型输入可追溯)；它不构成真实 Provider wire 请求的完整复现保证。
