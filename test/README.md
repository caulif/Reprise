# 测试维护与覆盖索引

默认测试运行当前行为与旧格式兼容回归；真实模型、Runtime 与 opt-in 浏览器用例单独说明证据边界。文件存在、测试通过和产品能力验收是不同事实。

## 测试维护

- 使用临时项目与夹具，不把开发者当前工作区作为被扫描的历史目录。
- 优先断言结果、事件、持久化与副作用。架构测试保留依赖边界，不锁定辅助函数名或文件拆分形状。
- 提示词快照负责提示词契约；流程测试优先通过工具与回执推进。
- 当前 Comparison 默认使用自主 Session；旧分阶段端口与旧日志恢复仍按原契约回归，不能当成当前默认路径的验收。
- Recovery 数据集逐条校验内容 hash，文件系统恢复按去除 case ID 后的不同内容及扰动执行；pack 标签不代表调用了对应 Runtime。权限不足仅跳过对应子用例。
- 改动后的验证命令与费用边界见[开发指南](../docs/development.md)。

## Comparison 场景索引

当前默认装配的提交、预览、修订、取消与历史重读由[自主发布联测](application/comparison-autonomous-publication.test.ts)覆盖，模型与 renderer 是离线替身。

以下保留历史 B9 场景的查找入口，不声明这些文件已证明整项能力，也不将索引计入行为测试。真实渲染和模型理解仍需各自证据。

| 场景 | 需要证明的行为 | 相关测试 |
|---|---|---|
| V1 dual HTML, history patch only, empty refs | history restore → register → render → dual images; baseline still empty | [comparison-historical-baseline.test.ts](application/comparison-historical-baseline.test.ts)、[b2-historical-freeze-discovery.test.ts](application/b2-historical-freeze-discovery.test.ts)、[comparison-evidence.test.ts](application/comparison-evidence.test.ts)、[comparison-render-tools.test.ts](application/comparison-render-tools.test.ts)、[comparison-openable-media.test.ts](application/comparison-openable-media.test.ts) |
| V2 dual animation, script/CSS diverge | multi-frame sampling with explicit source/conditions; no static PNG as motion proof | [artifact-renderer.test.ts](application/artifact-renderer.test.ts)、[comparison-render-tools.test.ts](application/comparison-render-tools.test.ts) |
| V3 one side unrestorable | show evidenced side + visible limitation; no fabricated pair; no forced winner | [comparison-publication-tiers.test.ts](application/comparison-publication-tiers.test.ts)、[comparison-publication.test.ts](application/comparison-publication.test.ts) |
| V4 multi-page / same basename / relative CSS+images | no cross-wiring by basename/index; entry-only copy does not break assets | [b2-historical-freeze-discovery.test.ts](application/b2-historical-freeze-discovery.test.ts)、[historical-final-discovery.test.ts](application/historical-final-discovery.test.ts)、[artifact-renderer.test.ts](application/artifact-renderer.test.ts) |
| N1 code fix task | repro/result diff can be the subject; screenshots optional | [comparison-publication-emptiness.test.ts](application/comparison-publication-emptiness.test.ts)、[comparison-agent-phases.test.ts](application/comparison-agent-phases.test.ts)、[comparison-report.test.ts](application/comparison-report.test.ts) |
| N2 text / translation | short excerpts visible; no mandatory image frame noise | [comparison-publication-emptiness.test.ts](application/comparison-publication-emptiness.test.ts)、[comparison-report.test.ts](application/comparison-report.test.ts) |
| N3 data / table | key numbers/checks usable; derived charts not labeled as model originals | [comparison-evidence.test.ts](application/comparison-evidence.test.ts)、[comparison-publication-emptiness.test.ts](application/comparison-publication-emptiness.test.ts) |
| C1 text-only model | can publish real images for humans; no image blocks; no claimed observation | [agent-host-input-capabilities.test.ts](application/agent-host-input-capabilities.test.ts)、[comparison-agent-phases.test.ts](application/comparison-agent-phases.test.ts) |
| C2 vision model | model receives sourced images; audit can reconstruct inputs | [agent-host-input-capabilities.test.ts](application/agent-host-input-capabilities.test.ts)、[pi-model-caller.test.ts](application/pi-model-caller.test.ts) |
| P1 same asset name across attempts; second fails | first report/media bytes unchanged | [comparison-historical-baseline.test.ts](application/comparison-historical-baseline.test.ts)、[comparison-publication-emptiness.test.ts](application/comparison-publication-emptiness.test.ts) |
| P2 cancel / no browser / render failure | no leaked subprocess; no half-registered facts; CandidateRun untouched | [artifact-renderer.test.ts](application/artifact-renderer.test.ts)、[comparison-render-tools.test.ts](application/comparison-render-tools.test.ts)、[comparison-openable-media.test.ts](application/comparison-openable-media.test.ts) |
| S1 malicious history JS / path / HTML network | no log program exec; no escape from evidence root; no credential leak; no external write | [historical-artifacts-extract.test.ts](products/historical-artifacts-extract.test.ts)、[artifact-renderer.test.ts](application/artifact-renderer.test.ts)、[comparison-shell-deny.test.ts](application/comparison-shell-deny.test.ts) |
