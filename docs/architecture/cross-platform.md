# Reprise 跨平台通用化设计（以 Pi 为主参考）

本文回答两个问题：Reprise 本身如何在 Windows、macOS、Linux 上运行；每个内部 Agent 如何在不同宿主上完成同一类操作。设计基于当前代码和已公开的 Codex、Claude Code、Grok Build、Pi 实践，优先采用 Pi 的边界与复用方式。

## 1. 参考实现提炼

### 1.1 Pi：把跨平台复杂度放在基础包和 Host

当前依赖的 `@earendil-works/pi-agent-core` 已提供几个关键模式：

- Agent 核心只处理消息、工具调用、事件流和 `AbortSignal`，不负责操作系统命令；
- 工具通过 `AgentTool` 注册，参数用 schema 描述，工具可声明串行或并行执行；
- `beforeToolCall` / `afterToolCall` 可统一做权限拦截、审计和终止；
- `transformContext`、结构化事件和 `agent_end` barrier 让 UI、持久化和压缩不依赖某个终端；
- Pi 将 `agent-core`、`pi-ai`、`pi-tui`、session backend 拆成独立包，原生能力按平台提供，核心包不强行携带所有平台依赖。

Reprise 应保留同样的分工：Pi Agent 只执行 Host 注册的工具；跨平台进程、文件和终端行为属于 Reprise infrastructure；TUI 只订阅事件。

### 1.2 Codex：结构化 Runtime 优先

Codex app-server 采用双向 JSONL/stdio 结构化协议，客户端不解析交互式终端画面。Reprise 的 Product Pack 应优先连接 Runtime 的 headless、SDK 或 RPC 接口，并把私有事件映射成公共 `RuntimeEvent`。

### 1.3 Claude Code：CLI 模式与协议模式分开

Claude Code 的 print/stream-json 模式适合自动化，交互 CLI 只用于人工体验。Reprise 不应让 Agent 通过终端 UI 猜测 turn boundary；应使用产品支持的结构化输入、acknowledgment 和版本探测。

### 1.4 Grok Build：PTY 是最后一层

Grok Build 将 headless/ACP 与交互 TUI 分开，同时单独维护 PTY、终端状态、pager 和按键处理。这说明通用 PTY 不是简单的跨平台补丁。Reprise 首选结构化 Runtime；确实无法绕过时，才在对应 Product Pack 内加入受限 PTY adapter。

## 2. 目标架构

```text
CLI/TUI
  -> Application / Orchestrator
    -> Core（状态机、事件、schema、报告）
      -> Ports（Runtime、Process、Workspace、Terminal）
        -> Infrastructure adapters
           -> win32 / darwin / linux
```

Core 和 Agent module 不读取 `process.platform`、`process.cwd()`，不拼 shell 字符串。启动层创建一次 `HostContext`，其中包含平台信息、能力、数据目录、默认 shell 和已解析的 Runtime。

```ts
interface HostContext {
  platform: 'win32' | 'darwin' | 'linux';
  arch: string;
  pathCase: 'sensitive' | 'insensitive' | 'unknown';
  defaultShell?: { kind: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish'; executable: string };
  capabilities: ReadonlySet<string>;
}
```

## 3. 项目本身的跨平台设计

### 3.1 路径与持久化

- 内部持久化路径统一为相对 POSIX 路径（`/` 分隔）；显示和系统调用时才通过 `node:path` 转为宿主路径。
- 所有 workspace 路径先 `resolve`，再做 containment 检查；拒绝 `..`、盘符切换、UNC 越界、符号链接逃逸和大小写碰撞。
- `data-dir` 由启动层解析：用户显式值 > `REPRISE_DATA_DIR` > 宿主用户数据目录；不直接假定 `HOME` 或 `USERPROFILE`。
- JSON/JSONL、manifest、模型输出继续经过 TypeBox `Value.Check`；写文件采用临时文件加 rename，并由 adapter 处理 Windows 锁、Unix mode 和 macOS 权限错误。
- Fingerprint、事件和报告中不保存宿主绝对路径作为语义标识，只保存逻辑相对路径和脱敏诊断信息。

### 3.2 进程与 Runtime

将现有 `process-runner` 和 Product Pack 进程逻辑收口为两个端口：

```ts
interface ProcessRunner {
  run(input: {
    file: string; args: readonly string[]; cwd: string;
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal; timeoutMs?: number;
  }): Promise<{ exitCode: number | null; signal?: string; stdout: string; stderr: string }>;
}

interface RuntimePort {
  discover(): Promise<RuntimeAvailability>;
  start(input: RuntimeStart): Promise<RuntimeSession>;
}
```

规则：

- 默认 `spawn(file, args, { shell: false })`；用户输入永远不能进入拼接后的 shell 字符串。
- `CommandResolver` 处理 POSIX 可执行位、Windows `.exe/.cmd/.bat` shim、PATH 分隔符和显式 executable path。
- 取消统一使用 `AbortSignal`。Windows 清理进程树，Unix 清理 process group；两者都映射为同一个 `cancelled` 事件。
- Product Pack 负责协议握手、版本探测和私有事件解析；ProcessRunner 不理解 Codex/Claude/Pi 语义。
- Runtime 会话记录 `resolvedExecutable`、版本、宿主 capability 和脱敏 argv，不记录密钥。

当前代码中的 `powershell` 工具应重命名为语义上的 `shell.exec` 或按产品能力注册：Windows 选择 PowerShell，macOS/Linux 选择用户可用的 POSIX shell；工具结果保留 `shellKind`，但 Agent 不写死命令语法。

### 3.3 文件系统与隔离工作区

`WorkspaceFs` 统一 `read/write/copy/rename/remove/stat`、原子发布、锁重试和权限错误。保留现有安全约束：恢复目标只能是普通文件，不跟随越界链接，staging 发布前后都做 fingerprint 与 source tripwire。

平台契约测试必须覆盖：

- Windows NTFS 重解析点、大小写不敏感和文件锁；
- macOS APFS 大小写配置、桌面目录权限和 Unicode 文件名；
- Linux symlink、mode/ACL、进程组和权限拒绝。

### 3.4 TUI 与终端

借鉴 Pi TUI：渲染层只接受事件和尺寸，不能拥有 Runtime 状态。`TerminalHost` 负责颜色、宽度、UTF-8、resize、Ctrl-C、EOF 和 alternate screen；无 TTY 时回退为纯文本 CLI。

首版不在 Core 引入通用 PTY。只有某个 Product Pack 的真实 Runtime 没有结构化模式时，才在该 Pack 内增加受限 PTY，并隔离平台 native helper；这与 Pi TUI 将 Darwin/Windows native 代码放在包内的方式一致。

### 3.5 包和发布

采用 Pi 式包边界：核心 npm 包保持纯 TypeScript/ESM；平台 native helper、PTY 或终端扩展作为可选包；lockfile 固定版本，不在运行时下载二进制。发布矩阵至少为 `windows-latest`、`macos-latest`、`ubuntu-latest`，Node 版本跟随 Pi 当前最低基线。

## 4. 每个 Agent 的跨平台执行设计

### 4.1 工具即能力，而不是 shell 别名

每个 Agent 只看到 Host 注册的工具：

- `workspace.read/write/edit/search`
- `project.test/build/check`
- `git.*`
- `shell.exec`（显式 opt-in，带 cwd、超时、输出上限）
- `run.cancel`

每个工具声明输入 schema、只读/写入副作用、所需 capability、串行/并行模式、超时和取消语义。Pi 的 `beforeToolCall` 用于 Host 统一拒绝越权调用，`afterToolCall` 用于追加审计字段和终止提示。

### 4.2 Host facts 与操作选择

会话开始时写入事件 `agent.host_facts`，只包含：OS/架构、shell kind、Git/Node 版本、路径大小写、PTY/符号链接能力、可用 Product Runtime。Agent 先读 facts，再选择工具；不自行读取凭据、扫描磁盘或猜测命令。

### 4.3 命令执行优先级

1. 结构化工具优先：文件、搜索、测试、Git 都用参数化 API。
2. 必须运行外部程序时使用 `file + args[]`。
3. 只有管道、重定向或 shell builtin 才使用 `shell.exec`；Host 生成对应 PowerShell/Bash/Zsh 脚本，Agent 只提交结构化意图。
4. cwd 必须由 Host 提供并通过 workspace containment 校验。
5. 非零退出、超时、取消、输出截断和缺少命令都返回结构化错误，并写入事件日志。

### 4.4 同一意图的工具映射

| 意图 | Agent 工具 | Windows | macOS/Linux |
|---|---|---|---|
| 搜索文件 | `workspace.search` | Node API / `rg.exe` | Node API / `rg` |
| 运行测试 | `project.test` | 解析 `npm.cmd` 后 argv | `npm` argv |
| Git | `git.*` | `git.exe` argv | `git` argv |
| 临时命令 | `shell.exec` | PowerShell | zsh/bash/fish |
| 取消 | `run.cancel` | 进程树 | process group/signal |

Agent prompt 中不再出现固定的 `powershell`、`grep`、`rm`、`export` 示例；示例应描述意图并给出工具 ID。

### 4.5 Pi Agent loop 的直接复用

- 用 Pi `Agent` 的事件流作为内部 Agent 的运行边界；事件写入 Harness audit sink。
- 用 `toolExecution: 'sequential'` 保护写入和发布工具；纯读取工具才允许并行。
- 用 `AbortSignal`、`agent.abort()` 和 `shouldStopAfterTurn` 实现停止、压缩和 graceful completion。
- 用 `transformContext` 注入经 schema 校验的 host facts、workspace briefing 和 retained tail；新增模型可见输入必须先记录事件。
- 不把 Pi session 文件直接当作 Reprise Experiment；Pi 负责 Agent 上下文，Reprise 负责领域状态、候选状态机和可恢复事件。

## 5. 落地顺序

### Phase 0：基线盘点

盘点 `process.platform`、`powershell` 工具、`.cmd` 特判、绝对路径、shell 字符串和 TUI 平台分支；定义 `HostContext`、`ProcessRunner`、`WorkspaceFs`、`TerminalHost` 和 capability schema。完成标准：契约测试能在当前 Windows 通过。

### Phase 1：端口化文件和进程

迁移路径、原子写入、隔离工作区、命令解析、Git 和取消逻辑；把 `powershell` 语义拆成 `shell.exec` + shell adapter。完成标准：三平台 CI 构建、`npm run check`、路径与进程契约测试通过。

### Phase 2：Runtime Pack

Codex 使用 app-server/stdio，Claude 使用 print/stream-json；只有协议不存在时才评估受限 PTY。完成标准：模拟 Runtime 在三平台生成相同规范化事件，取消不留下孤儿进程。

### Phase 3：Agent 工具迁移

Recovery、Controller、Comparison 全部改用统一工具 ID、capability 和 host facts；更新 prompt、schema、事件和恢复测试。完成标准：同一 TaskCase 在三平台使用相同工具 ID 完成，审计中无未声明副作用。

### Phase 4：正式支持

补齐安装、诊断、贡献者文档和发布矩阵；macOS/Linux 只有在真实端到端 smoke、文件语义和 TUI/无 TTY 验证完成后才从“未验证”升级为“正式支持”。

## 6. 已落地的第一批改造

当前代码已提供 `HostContext`、统一 shell adapter、`shell_exec` Agent 工具、Pi session 的 host facts 审计和跨平台报告打开器。CI 的测试矩阵已覆盖 Windows、macOS 与 Linux；结构化 Runtime 仍优先于 PTY，真实 Runtime smoke 继续显式 opt-in。

## 7. 验收与约束

- Core、Agent module、trace 和 renderer 不包含操作系统分支；差异只存在于 adapter、Product Pack 或可选 native helper。
- 同一输入在三平台产生等价的事件 schema、CandidateRun 状态和报告事实。
- Agent 的每次写入、进程启动和 shell 调用都可审计、可取消、可恢复。
- 缺少 Git、PTY、shell 或 Runtime 时返回 capability error，不猜测替代命令。
- 跨模块协议、on-disk 格式、prompt 或工具面变化时，同一变更更新 `docs/decisions/` 并增加反向用例。

参考资料：Pi `pi-agent-core` README、Pi TUI 包结构、Codex app-server、Claude Code CLI reference、Grok Build ACP/headless 与 terminal 模块，以及本项目的 `technology-selection.md`、`product-plugin-compatibility.md` 和 `environment.md`。
