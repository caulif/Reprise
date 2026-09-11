# Recovery Agent 正确性与可完成性后续规划

状态：proposed

本文基于当前代码审查，承接[后续代码修改清单](./recovery-agent-next-code-changes.md)和[Recovery Agent 模块重构实施计划](./recovery-agent-refactor.md)。目标不是提高理论上的历史证明强度，而是让 Agent 只对它实际能够观察、操作和验证的事实作判断。

## 1. 当前审查结论

当前代码已经完成主要结构迁移：

- source/workspace 分离和 sparse workspace 已存在；
- Agent 可使用 source、workspace、observations 和七个工具；
- 三轮 Session 和 `ready`/`blocked` envelope 已存在；
- `summary` 已进入 envelope，且有一句话长度约束；
- Provider 已将主要检查收敛为机械检查；
- 临时 Recovery 工作目录会在封存前清理；
- 相关 Recovery、Environment 和架构测试已有覆盖。

当前不应再把“证明完整历史一致”作为完成条件。Agent 无法观察未记录的历史，也无法恢复外部世界；它只能基于当前可读 source、历史辅助材料和实际操作结果判断一条合理恢复路径是否成立。

## 2. 需要修正的判断原则

### 2.1 `ready`

`ready` 表示 Agent 根据实际调查认为候选可以合理开始原始任务，不表示逐字节历史一致。以下情况可以继续：

- 缓存、构建产物或无关文件未知；
- 依赖可以重新安装或运行条件可以重建；
- 外部状态有差异，但不改变当前任务的输入和难度；
- 一些历史细节不可证明，但 Agent 已验证关键任务条件。

### 2.2 `blocked`

`blocked` 表示 Agent 找不到可执行且足够可信的恢复路径，继续会明显依赖猜测。典型情况：

- 关键输入无法找到或恢复；
- 当前文件可能已经包含任务结果，且无法判断或清除；
- 必要代码、资料或环境缺失，不能重建；
- 外部状态是任务核心条件且无法观察或替代。

未知本身不等于 blocked。是否影响任务由 Agent 判断，Host 不追加不可完成的历史证明要求。

## 3. 后续代码修改

### 3.1 Prompt 修正

在 `src/agents/recovery-agent.ts` 和两个 Product Playbook 中：

- 把“必须证明起点条件”的语气改成“根据可观察材料建立合理恢复路径”；
- 明确未知只有在可能改变任务输入、难度或暴露结果时才阻塞；
- 要求 `recovery.md` 区分观察、推断、已执行动作和未解决问题；
- 不要求 Agent 证明所有文件的历史存在，也不要求所有外部状态回到过去。

建议将 `src/agents/recovery-agent.ts` 中的 prompt 替换为以下语义。实现时可保留项目既有的可见过程文字和产品 Playbook 引用，但不得重新加入“完整证明起点”的要求。

#### System Prompt

```text
Work from the original task and the available workspace evidence to prepare a reasonable starting environment for that task.

The target is the condition before the original agent received the initial task. If the exact reception time is unavailable, use the earliest observable task operation as the conservative boundary. The current source directory may contain the task's later results; its current contents are material to investigate, not proof of the starting state.

You have one writable workspace, a read-only source view when available, read-only observations and any product playbook, and the registered workspace tools. You may inspect, copy, restore, remove, move, rebuild, install dependencies, run commands, and verify results as needed. Keep shell execution and writes in the workspace. Do not modify the user's source directory, credential stores, or global configuration.

Use the task meaning to decide what the candidate needs to face at the start. Keep or restore inputs and prerequisites, remove later results and answer material, and recreate runtime conditions when useful. Do not complete the original task for the candidate. Git, history, observations, and current files are complementary evidence; none is guaranteed to be complete.

Do not claim that an unobserved historical fact was verified. You do not need to prove that every file matched the past or that external services have returned to their historical state. Continue when the remaining unknowns do not materially change the task or expose its result. Stop with blocked when no reasonable recovery path remains and continuing would depend on guessing a key input, task condition, or result boundary.

Use the workspace's recovery-work directory for short notes only when they help continue the work. Move any task-required content to its normal path; temporary notes are removed before the workspace is sealed. Keep the goal, verified facts, completed actions, remaining checks, and blocking reasons available across turns.

At the end, write recovery.md with the recovery basis, actions, checks, assumptions, unresolved items, and why the remaining gaps do or do not affect restarting the task. Return the final envelope required by the current turn.
```

#### Turn 1 Prompt：理解与侦察

```text
Understand the original task and investigate the available starting materials.

Read the initial task, the starting boundary, and the current workspace/source summary. Inspect source, workspace, observations, Git, history, or other available material as needed. Work out what the task appears to require at the beginning, which current files may be later results, and which inputs or runtime conditions still need checking.

Do not scan or copy the entire source tree just to make it complete. Follow the task and the evidence. You may make an obvious safe preparation, but do not complete the original task. Continue with the next useful investigation or action in the same Session.
```

#### Turn 2 Prompt：恢复与准备

```text
Continue the recovery in the same workspace using the facts and actions already established.

Choose the next useful actions yourself. Read more source or history, copy or restore required files, remove later results and answer material, recreate useful configuration or dependencies, and run bounded checks when they help decide whether the task can restart. Keep the original task unfinished for the candidate.

After important actions, read back or otherwise verify what changed. Do not treat missing historical proof as a reason to stop when the task conditions are still reasonably reconstructable. Record only the remaining questions that could change the restart decision.
```

#### Turn 3 Prompt：自检与结论

```text
Make the final recovery decision from the workspace and evidence you can actually inspect.

Check the task's necessary inputs and runtime conditions, whether later results or answer material remain visible, whether the original task would still be a meaningful task for the candidate, and whether any unresolved gap materially changes that task. Repair safe, concrete problems before deciding.

Write recovery.md with what you observed, what you changed or rebuilt, what remains uncertain, and why those uncertainties do or do not block restarting the task. Return ready when you have a reasonable executable starting point. Return blocked only when no reasonable path remains and continuing would require guessing a key input, task condition, or result boundary. Include one short summary sentence in the final envelope.
```

### 3.2 readiness 与机械检查

检查 `src/application/recovery/readiness.ts`、`run-model.ts` 和 Provider：

- readiness 只提供 Agent 可以读取的路径和命令事实；
- 不因路径未列入 Host 派生清单就直接否决 Agent 的 ready；
- 不因零变更、测试失败或缓存缺失自动改写业务结论；
- 只阻止越界、源目录变化、报告缺失、workspace 超预算和无法封存等机械错误。

如果某检查需要判断“该缺口是否影响任务”，必须把事实反馈给同一 Session，由 Agent 决定，而不是在 Host 里增加规则。

### 3.3 旧状态和诊断字段

继续清理生产路径新生成的 `partial`、`insufficient_evidence`、`current_state_fallback` 和 `recovered_partial`。历史读取可兼容，但新 Recovery 结果和新 baseline 只使用 `ready` / `blocked`。`taskOutcome`、`verification` 等内部诊断可以保留，但不能重新成为第二套 Recovery 业务结论。

### 3.4 Source mount 安全

保留 source 只读、workspace 可写和 workspace shell cwd。验证 PowerShell 变量、别名、切换目录、junction、symlink 和相对路径无法写入 source。读取和复制 source 到 workspace 必须可用；Agent 不需要新的专用复制工具。

### 3.5 重试语义

- 模型请求、输出修复和机械反馈：保留同一 Session 与 workspace；
- workspace 损坏、source tripwire 失败或不可恢复的进程边界错误：丢弃并重新创建完整 Session；
- 真正重启必须从理解 turn 开始，不能复用旧 Session 的轮次游标。

## 4. 用户结果

最后一轮一次生成：

```json
{"status":"ready"|"blocked","summary":"一句话，最多 240 字符","reportPath":"recovery.md","unresolved":[]}
```

不增加摘要 Agent 或报告 Agent。用户界面直接显示 Agent 的 summary；完整解释读取 `recovery.md`。`blocked` 是可接受的正常结果，不能显示成系统崩溃；Provider/Host 自身失败才是技术失败。

## 5. 测试计划

- `ready` 带不影响任务的未知缺口；
- 关键输入缺失返回 `blocked`；
- 当前结果无法与起点区分返回 `blocked`；
- 可重建依赖缺失仍可 `ready`；
- 外部非核心差异仍可 `ready`；
- 无 Git 与有 Git 使用同一流程；
- source 读取和 workspace 写入同时发生；
- source 写入绕过尝试被拒绝；
- 机械反馈回同一 Session；
- 技术重启从 Turn 1 开始；
- summary 与报告由同一轮生成并被原样展示。

## 6. 下一步顺序

1. 先修正 Prompt 中过度要求历史证明的措辞；
2. 审查 readiness/Provider 是否仍把业务判断藏在机械检查中；
3. 清理旧状态新生成路径；
4. 完善 source mount 写保护和重试测试；
5. 添加上述 `ready`/`blocked` 边界 fixture；
6. 运行 `npm run build`、相关 `dist/test`、`npm run check` 和 `npm run verify:docs`。

完成标准是：Recovery 只承诺 Agent 实际能完成的判断，未知不会被过度阻塞，关键错误不会被放行，且用户能直接看到 Agent 的真实结果。
