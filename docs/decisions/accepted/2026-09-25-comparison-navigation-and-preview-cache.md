# 决策：Comparison 交付导航与 attempt 内预览复用

状态：accepted

## 问题

Comparison 已封存双方证据、变更路径和可打开的终稿，但理解轮仍需沿多份索引寻找交付物。报告预览每次复制所有可用媒体并启动渲染，即使草稿和渲染条件未变。

## 决定

- Briefing 增加有界的 `decision-map.md`，从已选 links/media、可打开终稿发现结果和 snapshot 状态生成双方交付线索与待核缺口。它只指向原始文件和短引用，不判定最终版本、质量或推荐；完整索引和源文件继续保留。候选 snapshot 不完整时不把可变副本作为交付线索。理解轮优先读取该页，读工具结果仍经 Agent Session 审计。
- `preview_report` 仍先预检草稿并用发布共用的预处理生成 HTML。只复制准备后 HTML 实际引用的媒体，核对 attempt 路径边界与登记的内容 hash；草稿、catalog revision 和实际媒体字节共同决定独立的准备目录。
- 成功截图在单 attempt 的工具实例中按依赖 digest、viewport、渲染器版本和采样时间做有界内存缓存。缓存命中仍重新核对源媒体、截图文件和独立的 review 媒体注册；失败与取消不缓存。`review-*` 不进入 comparison evidence catalog。正式发布始终重新校验当前草稿、证据和媒体，不读取预览缓存。
- 发布与预览共用 HTML 解析后的媒体 URL 提取。CSS `url(...)` 仍按已有规则处理。没有跨 attempt 或跨进程的持久缓存格式。

## 备选方案

**让模型自行探索所有索引。** 保留当前重复导航成本，也不能稳定提示封存终稿和证据缺口。

**跨 attempt 持久化截图缓存。** 需要新的磁盘协议和更复杂的失效与隐私边界；当前先按 attempt 内的重复调用复用。

## 影响

导航页避免新增模型总结调用和未经证实的任务结论。缓存只节省重复相同预览的浏览器成本；第一次预览仍需准备与校验，且每次命中仍读取相关媒体以保证新鲜度。保持四轮 Session、阶段边界、视觉声明和发布规则不变。

## 验证

`comparison-tracks.test.ts` 覆盖双侧线索、可打开终稿、索引截断和不完整 snapshot；`comparison-render-tools.test.ts` 覆盖只复制被引用媒体、hash 变化、草稿/catalog/viewport 失效、缓存文件或 review 副本丢失、取消与独立 review 引用。源码变更完成后运行 `npm run check`。真实模型对拍需要显式 opt-in，不能由离线测试推断耗时改善。
