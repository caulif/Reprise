# 决策：Recovery transaction boundaries

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted

## 问题

Recovery 把 Agent 决策、workspace 验证、历史命令 readiness 和 Git sink 审计耦合在一起，导致辅助设施失败覆盖有效的恢复决策。

## 决定

Recovery treats the Agent decision and Host workspace verification as separate phases. The Agent returns only a minimal decision; the Host creates the internal envelope and the Provider verifies workspace facts without reinterpreting the Agent protocol.

Readiness checks are mechanical and do not replay commands extracted from historical transcripts. Git sink isolation is an audit enhancement: a failed sink is reported on the prepared environment and does not discard an otherwise safe local workspace unless the task explicitly requires Git history.

## 备选方案

**保留多层协议校验和强制 Git sink。** 该方案会继续让辅助设施失败覆盖有效的 Agent 决策，因此不采用。

Keeping readiness command replay and treating Git sink creation as a mandatory preflight would make auxiliary historical and audit data decide whether the isolated workspace can be used. The smoke runs showed that this creates failures unrelated to the Agent's recovery decision.

## 影响

- Historical commands cannot make the live Recovery path fail because of shell, path, or version differences.
- Provider validation cannot disagree with Host envelope parsing.
- Agent decisions remain available when later verification or audit facilities degrade.
- Git sink failures require explicit task-level handling instead of being reported as model or Runner failures.

## 验证

Recovery contract tests、Provider workspace tests 和完整项目门禁验证这些边界。
