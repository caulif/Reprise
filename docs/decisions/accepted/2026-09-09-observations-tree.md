# 决策：只读 observations 完整物化树

状态：accepted

延续 [工作集与观察文件](./2026-09-07-recovery-working-set-and-observation-files.md)。目标见 [Application 与候选链重构](../../plan/application-candidate-agent-refactor.md) 阶段 C。

## 问题

Recovery 只能按需读取冻结材料，但观察树只有 transcript JSON、historical-events 和 Comparison 的 run-events。用户输入索引指向 `history/transcript/`，在 Recovery 挂载上不存在。原始 `sourcePath` 若写入观察树会把产品会话目录暴露给 Recovery。

## 决定

Host 把同一份冻结会话物化为只读 `observations/`：

```text
INDEX.md INDEX.tsv session.json
user-inputs/ transcript/ events/{historical,run}/
artifacts/ files/ metadata/ source-refs/
```

`session.json` 经 `ObservationSessionManifestSchema` 校验，只含 caseId、产品/会话身份、provenance、隐私开关和缺失列表，不含 `sourcePath` 与凭据。用户输入索引指向 `observations/user-inputs/{id}.txt`。凭据文件名、越权相对路径和未允许的二进制不复制，只记缺失。同一 TaskCase 重复物化得到相同 INDEX 与 session.json。

## 备选方案

**继续把历史用户路径指向 Comparison 的 `history/` 挂载。** Recovery 没有该挂载，索引对恢复无用。

**把产品原始 JSONL 拷进 observations。** 把私有协议和本机路径带进 Recovery 工作区。

## 影响

Comparison 与 Recovery 都从 observations 读取用户输入原文。Controller briefing 的 `history/transcript/` 仍由 Controller 材料投影拥有。TUI/CLI 摘要继续走冻结 TaskCase，不解析产品原始格式。

## 验证

`test/observation-files.test.ts`：截断、脱敏、用户输入顺序、稳定重物化、省略 sourcePath 与凭据文件。`npm run check` 必须通过。
