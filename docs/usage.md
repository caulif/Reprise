# 使用 Reprise

Reprise 是本地优先的任务对照工具：它从已安装 Agent 产品的历史会话冻结一个 `TaskCase`，在隔离工作副本中恢复任务起点，再由 Controller 生成开场消息，启动目标 Agent Runtime。Recovery、Controller 和 Comparison 使用 Harness 内部模型；候选模型由目标 Runtime 的目录提供。结果用于当前任务的个人判断，不是公共榜单、标准 benchmark 或质量保证。

## 开始

要求 Node.js 22.19 或更高版本。Windows 11 是已验证平台；macOS 和 Linux 的真终端与 Runtime 组合保持未验证。安装依赖并构建后，直接运行 `reprise`（无子命令）进入 TUI：

```powershell
npm ci
npm run build
node dist/src/cli/main.js
```

若已将本项目的构建产物注册为 CLI，也可使用 `reprise`；裸名 npm 包不是本项目。`--data-dir` 指定本机数据目录，默认是当前目录下的 `.reprise`；`--locale zh` 或 `--locale en` 保存操作者界面语言。

## TUI 路径

1. 在封面输入 `/intake`，依次选择来源产品、项目和历史会话。会话 `Enter` 打开核对页；核对页的 `Enter` 才冻结任务并开始恢复。原始会话不会被重放。
2. 等待恢复结论。只有 `已恢复` 或允许继续的 `部分恢复` 才能选择候选；缺关键输入或恢复被阻挡时不会启动候选。
3. 选择候选产品，再选择该 Pack 的模型目录项。候选目录来自 `ProductRuntime.listCatalog()`，不是 Harness 内部 Pi 模型列表。
4. 确认页只复述候选产品、请求模型和恢复结论。确认页 `Enter` 才启动候选；`b` 返回修改模型，`Esc` 返回封面。
5. 运行页是事件日志的只读投影。它显示 Harness、Controller 和 Target 的可见活动，不能直接给候选发送消息。运行中按 `Ctrl+C` 请求取消。
6. 结果页可用 `c` 生成对照（若该运行提供此入口），用 `o` 打开报告、`h` 打开历史终稿、`f` 打开候选终稿、`t` 查看 trace、`w` 打开隔离副本。

会话列表支持方向键、可打印文本筛选、`Ctrl+F` 切换可运行过滤、`Ctrl+N` 加载下一页、`Ctrl+R` 从第一页刷新。配置页用方向键选择字段，`Enter` 编辑或切换，`Ctrl+T` 测试连接，`Ctrl+S` 保存本地配置。

## CLI

无子命令进入 TUI；脚本和自动化可使用 JSON/JSONL 的无头命令：

```text
reprise prepare (--source-root <dir> --task-case <file.json> | --source-product <id> --source-path <path>)
reprise run (--source-root <dir> --task-case <file.json> | --scenario <experimentId>) [--product <id> --model <id>]
reprise compare (--experiment <id> | --source-root <dir> --task-case <file.json>)
reprise products|models|projects|sessions|inspect|import|history|events|auth
reprise config get|set
reprise cancel <operationId|experimentId|runId>
```

`--product` 与 `--model` 必须成对提供。`prepare` 只准备和封存，不接受候选选择；`run` 从封存场景或 TaskCase 启动候选；`compare` 生成已保存运行的对照。`--json` 与 `--jsonl` 互斥。不要把 API 密钥放进命令行参数。

## 配置 Harness 内部模型

配置页保存一份供 Recovery、Controller、Comparison 共用的默认 Harness 模型。第三方 OpenAI-compatible 服务需要 provider、model、base URL 和凭据；连接测试会发出最小请求，可能产生服务费用。配置保存在 Git 忽略的 `.reprise/harness-model.json`，也可将密钥写成 `env:NAME` 引用。密钥值不会写入事件、artifact 或报告。

官方 Pi catalog 通过 Pi 的 `/login` 管理登录，凭据由 Pi auth.json 保存；然后在配置页选择对应 catalog。Reprise 不读取或保存 Codex CLI、Claude Code 的登录文件。候选 Runtime 继续使用用户在目标产品中的登录态；Reprise 不替用户切换全局模型配置。

真实验证脚本要求显式 opt-in；默认开发检查使用本地 fixture。TUI 的恢复、候选运行和对照是用户主动触发的实际任务，同样可能计费，连接测试也会调用模型。

## 边界

候选在隔离副本运行，源目录受写保护；网络、外部服务和其他路径不会被 Reprise 统一沙箱化。无法安全重放的数据库、部署、支付或网页副作用应使用测试账号、mock、只读观察或取消。历史 Runtime 只是证据，候选使用当前机器可解析的 Runtime；无法观察的配置记录为未知。运行输出不同于历史结果是正常情况，比较报告提供证据而不是统一分数。

报告、trace 和隔离副本是本机文件。不要把含有密钥、会话正文或私有路径的产物提交到 Git。

