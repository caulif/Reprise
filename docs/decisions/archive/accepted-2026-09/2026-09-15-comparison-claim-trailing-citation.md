# 决策：data-claim 接受紧随其后的证据锚点

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-15

补充 [分层与 data-claim](./2026-09-15-comparison-prompt-layers-and-data-claim.md)。无引用仍失败。

## 问题

模型常把核验句写成「声明 + 括号里的证据链接」：`data-claim="verified"` 在 span 上，`data-evidence-ref` 在紧随其后的 `<a>`。Host 只看元素内部与祖先，真实对照因此 `evidence_unresolved`，尽管短名在索引里可解析。

## 决定

Host 在声明元素内部、祖先之外，还收集紧随其后、中间只有空白或常见括号标点的 `<a data-evidence-ref>` / `<img data-media-ref>`。无引用或短名不可解析仍失败。compose / 审阅提示与模板注释写明「写在 span 内或紧随其后」。

## 备选方案

**只加强 prompt，Host 仍要求写在 span 内。** 中文括号引用会稳定撞门。

**扫描整个父段落的全部短名。** 段落后面无关链接会误过。

## 影响

`evidence_unresolved` / `media_unavailable` 仍表示「声称核验或看过图但没有可解析引用」，不表示「必须把属性写在同一个开标签上」。

## 验证

`test/application/comparison-publication.test.ts`：`</span>（<a data-evidence-ref="ev-03">` 且索引可解析则发布；同一 HTML 无索引条目则仍 `evidence_unresolved`；光有 `data-claim="verified"` 无引用仍失败。`npm run check` 必须通过。
