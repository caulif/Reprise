# 决策：Host 抽取最后一个合法 JSON 对象，并丢掉模式非法的 evidence ref

状态：accepted

## 问题

MiniMax 在修复轮把 `<think>`、带 `|` 的合同样例和文末 `done` 对象写进同一条消息。Host 从第一个 `{` 切到最后一个 `}`，整段无法 `JSON.parse`，审计写成 `invalid JSON`，即使文末对象可以单独通过 schema。模型还会把文件路径写进 `evidenceRefs`，整单被 TypeBox 拒绝。

## 决定

解码前去掉 `<think>…</think>`。从文本中找出每一个括号匹配且能 `JSON.parse` 的对象，**采用最后一个**。Markdown 围栏规则不变。

Controller 在 schema 校验前丢掉不符合 `event:`/`artifact:` id 模式的 `evidenceRefs` 项。目录里不存在的合法 id 仍返回 `unknown evidence reference`。不把任意绝对路径暴露给工具；会话外附件只在冻结时按用户句点名拷进 `imported-inputs/`。

## 备选方案

**放宽 schema，允许路径当 evidence。** 证据目录与事件 id 会分叉，TUI 和对照无法解析。

**整场失败交给模型自己改。** 真实跑表明修复轮会把 think 和样例叠回去，Host 启发式比再烧一次修复更稳。

**工具可读全盘。** 候选会读到密钥和无关仓库；附件问题用冻结拷贝解决。

## 影响

`pi-agent-host` 的 `parse` 影响 Recovery、Controller、Comparison。相对路径允许 `\` 等价 `/`。确认页突出 resolved 模型名。对照失败页带失败分类。

## 验证

`test/agent-host.test.ts`：think + 非法样例 + 文末 `done` 完成。路径型 ref 被丢掉后 `done` 通过；未知 `event:` id 仍失败。`test/recovery-tools.test.ts`：`dir\\file` 可读，绝对路径仍拒。`test/session-start-workspace.test.ts`：cwd 外附件进入 `imported-inputs/`。反向：纯散文仍 `invalid JSON`；`type: stop` 仍 schema 失败。
