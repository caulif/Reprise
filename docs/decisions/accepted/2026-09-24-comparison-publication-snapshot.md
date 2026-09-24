# 决策：对照预览与发布使用同一份已校验内容

状态：accepted

## 问题

最终校验曾在关闭 Comparison 受管后台进程之前执行，发布时又从磁盘重读 `report.html`。进程可在两步之间改写文件。原始证据链接只在预览时从源路径复制，正式发布未固定预览所见的字节版本。

## 决定

先关闭受管进程与浏览器，再完成最终报告校验。校验结果携带内存中的 HTML 和 model，发布直接使用这两个值，不重新信任 attempt 的输出文件。

原始证据登记时读取有大小上限的源文件，计算 SHA-256，并写入 attempt 的内容寻址封存路径。目录记录的 `reportHref` 与 `contentHash` 指向该副本；预览及正式发布均校验封存字节并从中复制。源文件后续修改或删除不得改变已预览报告的证据目标；封存副本被改写则拒绝发布。

初始证据目录的 `reportHref` 相对 experiment 根解析；截图工具在 attempt 的 `media/` 生成并追加的链接相对 attempt 根解析。封存时必须保留这个来源区别，不能仅凭相同的相对路径文本推断源目录。

## 备选方案

**发布时重新读取源文件并比对 hash。** 源文件被删除时报告仍会产生失效链接，也无法保证预览和正式报告读取同一份字节。

## 影响

新 attempt 的原始证据 `reportHref` 是封存路径，不再直接引用可变工作区或 run 文件。既有报告及 attempt 不迁移。发布仍先写资产与 model，最后原子替换正式 HTML。

## 验证

`test/application/comparison-evidence-publication-review.test.ts` 覆盖预览后源文件变化而正式链接仍打开封存字节；`test/application/comparison-tracks.test.ts` 覆盖 `writeComparisonBriefing` 截图成功后从 attempt 目录封存；对照发布与 attempt 测试覆盖校验、发布和受管资源生命周期。
