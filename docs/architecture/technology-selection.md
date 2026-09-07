# Reprise 技术选型与实现基线

状态：当前实现基线（已确认）

本文把当前架构落实为一组克制的实现选择。它不重新定义 Harness 的领域模型、Agent 模块或 Product Pack；这些仍以[架构总览](./overview.md)及各专题设计为准。本文只回答：第一版用什么实现、复用什么、哪些复杂度暂时不引入。

## 1. 第一性原理

这个项目真正需要自己拥有的只有四类能力：

1. Harness 的领域状态和运行事实；
2. 外部 Agent Runtime 的生命周期与结构化事件；
3. 三个内部 Agent session 的编排；
4. TUI 和 HTML 对既有事实的投影。

用户一次只比较少量候选，通常是本机单用户、单进程、串行执行。可靠性主要来自输入接受边界、append-only trace、隔离副本和可恢复生命周期，不来自数据库、分布式框架或通用终端自动化。

成熟产品给出的共同启发是：

```text
结构化 Runtime 协议  →  Harness 事件与事实  →  TUI / HTML 投影
        控制面                 事实面                 展示面
```

TUI 可以退出或重建，但不能定义 Runtime 的 turn boundary，也不能改变已经持久化的运行事实。

## 2. 推荐收口

| 事项 | 第一版选择 | 明确不做 |
|---|---|---|
| 主语言 | TypeScript，ESM | 第二种实现语言 |
| 最低运行时 | Node.js `>=22.19.0`，跟随当前 Pi 基线 | 为旧 Node 降低 Pi 版本或增加兼容层 |
| 包管理 | npm + `package-lock.json` | 多包发布和 workspace |
| 架构形态 | 单 package 的模块化单体 | 微服务、DI 容器、通用 workflow engine |
| Pi 依赖 | `pi-agent-core`、`pi-ai`、`pi-tui` | 用 `pi-coding-agent` 充当应用框架 |
| Schema | TypeBox | schema registry、跨语言 IDL |
| CLI 参数 | `node:util.parseArgs` | 提前引入 CLI 框架 |
| 本地事实 | UTF-8 JSON/JSONL + 本地目录 + 单 Experiment writer lock | 数据库、远程 tracing 服务 |
| 子进程 | `node:child_process.spawn` 起步 | `shell: true`、通用 PTY 层 |
| Runtime 控制 | 产品原生结构化协议 | 解析 ANSI TUI 输出定义生命周期 |
| TUI | `@earendil-works/pi-tui` | 自研 widget framework、dashboard 系统 |
| HTML | 自有静态 renderer | Web 框架、本地 server、第二套应用 |
| 发布 | 一个 npm CLI 包、一个主命令 | 首版编译原生单文件 executable |
| Product Pack | 首个纵切片只源码静态注册 Codex；通过后再规划 Claude Code | 首版外部插件加载、插件市场、目录扫描、动态执行代码 |
| 候选调度 | 默认串行 | 为吞吐量建设并行调度器 |
| 首发平台 | Windows 11 正式支持 | 未验证就承诺全平台一致 |

## 3. Pi 的复用边界

### 3.1 直接复用

第一版将下列包声明为直接依赖：

```text
@earendil-works/pi-agent-core
@earendil-works/pi-ai
@earendil-works/pi-tui
```

它们分别负责 Agent session、context/tool loop，provider/model，以及终端渲染与基础组件。Recovery、Controller、Comparison 共享同一个 Pi Agent Host 实现，但拥有独立 session、prompt、上下文和工具权限。

`@earendil-works/pi-telemetry` 暂不列为必选直接依赖。Pi Agent Core 和 AI 已使用它；实现时先确认公开事件能否覆盖 token、耗时和 provider 事实。够用就复用，不够用只补 Harness 所需的规范化字段，不建设另一套遥测框架。

### 3.2 不复用 Pi 的应用壳

不把 `@earendil-works/pi-coding-agent` 当作 Harness 框架。它的 session、工具、扩展、CLI 和 HTML 导出服务于通用 coding agent；Harness 已有自己的 TaskCase、Experiment、RuntimePort、Environment、trace 和 Comparison 语义。套用整个应用壳会让两套产品模型相互污染。

可以局部借鉴其进程兼容处理、TUI 组合和自包含 HTML 思路，但 Harness 领域对象不得依赖 Pi Coding Agent 的 session entry 或 UI state。

### 3.3 版本策略

- Pi 的 core、ai、tui 使用同一个精确版本，并提交 lockfile；
- 不自动跟随 `latest`，Pi 升级使用独立变更，一次同步升级相关包；`22.19.0` 是当前最低基线，不是永久锁死的产品承诺；当 Pi 提升最低 Node 版本时，Harness 通过一次明确的基线升级跟随；
- 升级只验证三个高价值契约：Agent 能产生合法结构化结果、provider 配置能解析、TUI 启停后终端能恢复；
- Experiment manifest 记录实际 Pi 包版本以便追溯，但 Pi Host 版本不是候选模型严格对照的判定条件。

2026-08-09 调研时，上述 Pi 包均为 `0.84.1`，最低 Node 为 `22.19.0`。这里记录制定基线时的事实，不要求永久停在该版本。

## 4. CLI 与 TUI

### 4.1 一个入口，少量命令

默认无参数进入 TUI；只有出现明确自动化用途才增加非交互命令。建议起步最多保留：

```text
reprise                       # 主 TUI
reprise compare [case]        # 直接开始比较
reprise open <experiment-id>  # 查看已有实验
```

参数解析先用 `node:util.parseArgs`。命令树和 shell completion 真实变复杂后，再考虑专用 CLI 框架。

### 4.2 TUI 只是事件投影

使用 `pi-tui` 展示活动流、Controller 可见过程、候选进度、只读 Runtime 详情和结果入口。组件订阅 Harness 事件或读取已保存投影，不直接拥有 Runtime 子进程，不从屏幕文本推断输入是否被接受。

优先使用已有 Text、Markdown、ScrollView、VStack、HStack 等组件。主屏还是 alternate screen 属于实现纵切片中的体验选择，不应现在进入领域协议。

### 4.3 首版不做通用 PTY

成熟产品支持自动化时都提供了与人机 TUI 分开的接口：

- Codex app-server 使用双向结构化消息，默认 stdio transport 是 JSONL；
- Claude Code print mode 支持 `stream-json` 输入输出和用户消息 acknowledgment；
- Grok Build 提供 headless/ACP，同时其源码中单独维护 PTY、终端状态、pager、按键和大量场景测试。

这说明模拟交互式终端并不是轻量的通用后备方案。第一版正式规定：

> Product Pack 必须优先使用目标 Runtime 当前版本公开的 structured、headless、SDK 或 RPC 接口。Core 不提供通用 PTY adapter。

若某个必须支持的历史版本只有交互式终端入口，先把它报告为该 Product Pack 的能力缺口。只有真实任务证明无法绕过时，才在对应 Product Pack 内部加入受限 PTY 支持，并继续映射到统一 RuntimePort。

## 5. Schema 和 trace

使用 TypeBox 同时表达 TypeScript 类型与运行时 schema，只在不可信或可演进边界校验：

- 历史 session 和 Product Pack 输入；
- Runtime 结构化事件；
- 三个内部 Agent 的结构化输出；
- manifest、JSON、JSONL；
- CLI 和用户配置。

模块内部已构造的可信对象不重复 parse。Runtime 私有协议 schema 归 Product Pack 所有，先验证再映射为公共 RuntimeEvent；例如 Codex 能从对应 CLI 版本生成匹配的 TypeScript/JSON Schema，但这些类型不能成为 Harness 的公共协议。

Harness durable trace 使用一行一个完整事件的 UTF-8 JSONL。需要明确区分：

- Harness trace：能重放状态的领域事实；
- Pi/Runtime telemetry：token、耗时和调用等可用事实；
- 诊断日志：只用于排错，不参与重建，也不记录密钥或无必要的完整 prompt。

第一版不上数据库、日志框架或 OpenTelemetry Collector。append-only、原子替换和崩溃修复继续以[持久化与崩溃一致性](./persistence-and-crash-consistency.md)为准。

## 6. 子进程和 Runtime 控制

职责保持两层：

```text
Process Host
├── resolve executable
├── spawn / abort / timeout
├── stdin/stdout/stderr 管道
├── 进程退出与清理
└── 原始输出持久化

Product Runtime Adapter
├── argv 与环境变量
├── 协议握手
├── start / submit / cancel
├── input accepted 与 turn boundary
└── 私有事件 → RuntimeEvent
```

Process Host 不理解 Codex/Claude Code 语义；Product Pack 不各自发明跨平台进程管理。

先使用 `node:child_process.spawn`：

- 使用 argv 数组，默认 `shell: false`；
- stdout/stderr 有界送入 UI，完整原始流写入 Harness 所有的文件；
- AbortSignal、超时和进程退出映射为明确事件；
- 记录 resolved executable、报告版本和脱敏后的 argv；
- 凭据只经 Runtime 支持的环境或配置传递，不进入 trace。

Windows 的 `.cmd`/`.bat` 经 `spawnRuntimeProcess` 启动：ComSpec `/d /s /c`、整行外包一层引号、`windowsVerbatimArguments`，见[cmd shim 启动](../decisions/accepted/2026-09-06-windows-cmd-shim-spawn.md)。信号语义和子进程树清理必须在真实纵切片验证。如果标准 `spawn` 由此产生多处分支，再采用 Pi 已使用的 `cross-spawn`。首版不预先引入 `node-pty`，也不以 `shell: true` 解决 PATH 问题。

## 7. Runtime 发现和版本

确定性发现顺序为：

```text
用户显式 executable path
→ PATH 中 Product Pack 声明的命令名
→ version probe / protocol handshake
→ 记录 resolved path、reported version、capabilities
```

不扫描整个磁盘，不穷举 npm、pnpm、brew 等全局目录，也不为了发现 binary 读取无关私有配置。Product Pack 只声明少量命令名、版本探测和结构化接口能力。

发现不代表兼容。当前 Runtime 的协议适配仍按[Product Pack 兼容性](./product-plugin-compatibility.md)处理；Harness 不恢复或匹配历史 Runtime 版本，只记录当前实际版本和同一 Experiment 候选之间的 `runtime_drift`。

Runtime 下载不属于首版 Harness。自动下载会引入来源校验、许可证、签名、缓存和供应链责任；用户通过产品已有安装方式准备 executable，Harness 只验证和使用。

## 8. 平台范围

第一版正式支持 Windows 11，因为当前开发和首批真实任务在 Windows，进程终止、路径、文件锁、软链接和环境恢复必须在真实平台验证。

同时保持边界：Core、Agent Module、trace 和 renderer 不写 Windows 专属逻辑；差异封装在进程与文件系统基础设施、Product Pack 和 Environment Provider 中。macOS/Linux 不故意阻断，但在完成端到端验证前只标为未验证。记录下来的盘符路径（会话 cwd、历史写入、报告短路径）在任何宿主上都按 Windows 路径比较，不得 `resolve()` 进 `process.cwd()`；本机打开或删除文件仍用宿主 `node:path`。

不要同时承诺 Windows、WSL、容器、macOS 和 Linux 一致。WSL、容器和远程机器是 Environment capability，不是一个平台布尔值能解决的问题。

## 9. HTML 报告

Comparison Agent 直接写入自包含的 `report.html`；Host 只持久化、校验薄信封并导航，不使用 Markdown renderer 或固定 HTML 模板：

- 无前端框架、客户端状态管理和本地 server；
- CSS 与必要脚本内联；
- renderer 只转义、布局和链接，不重新解释 Agent 结论；
- 只链接 experiment-owned 安全副本，不暴露任意本机绝对路径。

可以借鉴 Pi Coding Agent 的自包含导出思路，但不能直接复用其 session 数据模型。

## 10. Product Pack 加载

首个纵切片源码只静态注册 Codex：

```ts
const productPacks = [codexProductPack];
```

每个 pack 仍包含 manifest、session source、runtime adapter、Recovery skill 和 fixtures。静态注册已经具备模块边界和编译期检查，不需要动态加载机制。

暂不做目录扫描、插件市场、热加载、包级 ABI、插件沙箱、签名体系或为尚不存在的第三方作者冻结 API。未来确有仓库外 Product Pack 需求时，优先考虑用户显式配置可信 npm 包，而不是自动执行目录中的代码；现在不设计该接口。

## 11. 打包和依赖面

“单一 CLI”表示用户安装一个 npm 包、运行一个命令；内部仍是模块化单体。首版不使用 Bun compile、pkg、nexe 或自建原生安装器，因为这会增加动态资源、原生依赖、代码签名和跨平台发布问题。

概念上的生产依赖面应接近：

```json
{
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "dependencies": {
    "@earendil-works/pi-agent-core": "<精确版本>",
    "@earendil-works/pi-ai": "<同一精确版本>",
    "@earendil-works/pi-tui": "<同一精确版本>",
    "typebox": "<兼容的精确版本>"
  }
}
```

`cross-spawn`、diff 库、HTML 模板库都不预先加入。实际纵切片证明标准库不足时，再增加一个最小依赖。

## 12. 暂不收口的细节

以下问题不阻塞项目骨架，应由一条真实 Codex 纵切片和一条 Claude Code 纵切片回答：

- Pi telemetry 是否需要显式直接依赖；
- Windows 下原生 `spawn` 是否足够；
- TypeScript 构建最终使用稳定 `tsc` 还是届时 Pi 已稳定采用的工具；
- TUI 默认使用 main screen 还是 alternate screen；
- HTML 严格单文件还是 HTML 加 experiment-owned artifact 目录；
- macOS/Linux 何时升级为正式支持。

现在冻结这些细节的收益低于后续修改成本。

## 13. 已确认的范围决定

以下决定已确认，作为第一版实现基线：

1. 接受 Node.js `>=22.19.0`。该版本跟随当前 Pi 的最低运行要求；不为旧 Node 降低 Pi 版本，也不增加兼容层。未来 Pi 提升最低版本时，Harness 通过一次明确的基线升级跟随，而不是在每个模块中长期维护多套 Node 分支。
2. 第一版只把 Windows 11 称为正式支持平台。Core 和领域模块保持平台无关；macOS/Linux 在完成真实端到端验证前只标为未验证。
3. 首个纵切片只静态注册 Codex Product Pack；Codex 真实纵切片通过后，再单独规划 Claude Code。外部 Product Pack 的加载、分发和安全边界不属于当前兼容承诺；未来出现真实第三方需求时再设计显式可信 npm 包加载，不预先实现动态机制。

这三项决定主动放弃了一部分旧 Node 覆盖和即时第三方扩展，换取与 Pi 一致的运行时地基、编译期可检查的产品边界和更小的安全/供应链责任面。

## 14. 调研依据

- [Pi monorepo](https://github.com/earendil-works/pi)：TypeScript/ESM、Node 版本、包拆分、依赖和构建方式。
- [Pi TUI](https://github.com/earendil-works/pi/tree/main/packages/tui)：main/alternate screen、差分渲染、同步输出、滚动与基础组件。
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)：面向富客户端的结构化集成、stdio JSONL、双向事件和按 CLI 版本生成 schema。
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)：print mode、`stream-json`、用户消息 acknowledgment、结构化输出和版本探测。
- [Grok Build](https://github.com/xai-org/grok-build)：headless/ACP 与交互 TUI 分层，以及 PTY/terminal/pager 模块体现的真实复杂度。

借鉴范围限于公开接口和架构边界，不复制任何产品的私有协议、内部 prompt、会话格式或视觉外观。
