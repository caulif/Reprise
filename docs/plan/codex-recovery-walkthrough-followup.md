# 走查后恢复体验修正

状态：完成

范围：2026-08-30 同会话复跑后仍成立的缺口。不扩大为候选 Runtime、冻结 `initialInput`、跟随出根 symlink。  
依据：走查事实在本机 `docs/.local/`（不受控，本文不链过去）、[上一轮修正](./codex-real-session-recovery-correction.md)、[无 accept 不得开跑](../decisions/accepted/2026-08-30-recovery-failed-blocks-candidate.md)、[列表与 Recovery 分界](../decisions/accepted/2026-08-27-session-intake-vs-recovery-agent.md)。

## 1. 要变成真的事

同一次真实会话走到确认页时，除上一轮四条外还必须成立：

1. **列表题目**：项目「最近活动」和会话行用后续短用户任务句，不是摘要窗口里的 skill / `AGENTS.md` 首段。
2. **时间线人话**：恢复工具行能看出工具名和相对路径；Host 失败不标成候选产品名；不把 SHA-256 当正文。
3. **确认页自洽**：无法恢复时标题、环境行、对照起点与 `hasAccept` 一致，禁止写「已准备隔离对照」。
4. **弱证据可看**：Verifier `pending_user_review` 且 envelope `partial` 时，操作者看得到可审查 preview（有 `accept`），而不是 Provider 因「manifest 路径集合不完全相等」把 staging 丢掉后只剩 fallback。
5. **删除停得住**：空转 `delete_file` 在调查预算耗尽前停止；根上无 Git 时 `inspect_git_history` 返回「不是仓库」，不报路径协议错误。

Done means：`npm run check` 通过；TUI 改动更新 `docs/tui-audit/frames/`；新门禁带反向用例；不启动真实候选 Runtime。

## 2. 非目标

- 改冻结契约「第一条用户消息永远是 `initialInput`」。
- 跟随出根 `node_modules`、放宽快照、开放 shell、提高无界工具预算。
- 自动接受弱证据并默默开跑。

## 3. 批次

| 批次 | 主题 |
|---|---|
| G | 列表/预览：`laterUserSummaries` + `taskDisplaySummary` |
| H | 时间线：路径、哈希、恢复失败语音 |
| I | 确认页文案随 `hasAccept` / `failed` |
| J | 恢复准备条不用「将在 Codex 里重做」 |
| K | `partial` manifest 允许额外变更路径，保留 preview/`accept` |
| L | `delete_file` 总次数上限；无仓库的 Git 检查 |
| M | 顶栏「未选 Agent」改为「未选会话产品」 |

回滚：还原对应源文件、测试、frames 与 ADR。

---

### G — 列表展示后续用户句

Discovery 摘要窗口会看到第二条用户消息（走查 `u2`）。`SessionSummary` 增加可选 `laterUserSummaries`。`sessionTitle` / 项目「最近活动」走 `taskDisplaySummary(summary, laterUserSummaries)`。冻结 `initialInput` 仍是第一条。

**验收**：`test/intake-ui.test.ts` 夹具：首条 instruction、次条短任务 → 列表题是短任务。反向：没有后续句时仍显示首条。

### H — 时间线

- `safeParams`：staging 相对 `path` 原文进入 audit（截断），禁止占位 `relative-path`。
- `recovery.started` 的 digest 不作为时间线 detail。
- 恢复失败行语音为 Recovery，不套候选产品名。

**验收**：timeline / widgets 测试：失败 detail 含相对路径；不得出现 `relative-path` 占位；哈希不出现在可见 detail。

### I — 确认页

无法开跑时：标题不是「启动隔离候选」；环境不是「已准备」；不渲染「对照从隔离状态开始」。封面「源目录就绪」在 `failed` 时改为不可开跑。

**验收**：`test/widgets.test.ts` / `test/tui-workflow.test.ts` 反向：`hasAccept=false` 帧不得含 isolated-start 句。

### J — 恢复准备文案

`preparePhase==='check'` 使用恢复专用句，不提候选重做。

**验收**：run-phase / widgets：恢复准备帧不得匹配「用候选模型重做」。

### K — partial 预览

`validateManifest`：`recovered` 仍要求路径集合全等；`partial` 要求每条 manifest action 都落在实际变更上，**允许**额外变更。校验通过则 `validateRecovery` 返回 preview 且 `accept` 存在。用户终态为部分恢复；确认页可开跑，限制必须可见。放弃「partial 也必须路径全等否则整单 fallback」。

**验收**：environment / recovery 测试：partial + 额外删除路径 → preview + accept。反向：manifest 写了未发生的路径仍拒绝。

### L — 删除与 Git

- 调查阶段 `delete_file` 累计上限（16）；达到后只允许完成工具。
- `inspect_git_history`：候选根不是 Git 仓库时返回 `isRepo=false` 的 Host 诊断，不因空/非法 paths 伪装成「缺 Git 证据」。

**验收**：recovery-tools：第 17 次 delete 失败；非仓库 inspect 成功返回 `isRepo=false`。反向：第 16 次仍可成功（若路径合法）。

### M — 顶栏灯

`noAgentSelected` 文案改为未选**会话产品**，避免理解成 Harness 未配置。

**验收**：home 帧 / widgets 含新文案，不含把空心灯解释成未配模型。
