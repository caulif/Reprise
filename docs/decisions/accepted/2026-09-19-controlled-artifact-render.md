# 决策：受控产物渲染与报告预览

状态：accepted

## 问题

Comparison 需要从已封存 HTML/SVG/raster 得到可引用预览帧，并在审阅时机械检查真实 `report.html`。现有单次 Chrome `--screenshot` 无法证明依赖加载、拦截外网、多帧动画或取消清理；也不能把报告截图混进 baseline/candidate 证据。

## 决定

- 渲染入口为 `renderFrozenArtifact`（`src/infrastructure/artifact-renderer.ts`）。对文档类产物：临时只绑定 `127.0.0.1` 的 bundle 静态服务 + 独立 Chrome/Edge profile + CDP（navigate / Fetch 拦截 / page-world 外联闸 / capture）。对已封存 raster：直接拷贝为单帧，不启动浏览器。
- 只允许当前 bundle origin 与 `data:`/`blob:`（页面文档资源）；阻断 `file:`、其他 loopback 端口、外网、WebSocket、EventSource、`sendBeacon`、Worker / SharedWorker / ServiceWorker、新窗口与下载。page-world 闸拒绝 Worker·SW 构造与 `serviceWorker.register`（worker 全局不受页面闸约束，故直接禁止）；CDP 关闭 worker / service_worker / shared_worker target；Fetch 拦截页面 HTTP(S)。未能建立受控加载时返回 `capability_unavailable`，不用宽权限 `file://` 或 `--no-sandbox` 兜底。
- 动画采样在 `Page.load` 之后按 `performance.now()` 墙钟等待请求时刻，并回报 `actualTimeMs` 与 `timing_mode=wall_clock_after_load` 诊断。当前 Chrome 在导航前 `Emulation.setVirtualTimePolicy(pause)` 会使 load 挂起，因此不采用该虚拟时刻路径。
- Host openable 截图经同一渲染器；测试注入 fake renderer。真实浏览器多帧验收仅本地 opt-in：`REPRISE_OPT_IN_BROWSER_RENDER=1`。
- `render_artifact` / `preview_report` 工具工厂在 `comparison-render-tools.ts`，依赖 B3 的 catalog 端口（`resolveSource` / `registerDerivedMedia` / `revision`）。`preview_report` 先用与发布相同的 `preparePublishableComparisonHtml` 物化临时 HTML（format-2：仅在 `comparison` / `details` 区内把 `data-media-ref` 写成可加载 `src`）；`report_review` 使用独立 `review-*` 短引用，不得 mint `media-*` 以免污染比较证据 allowlist。
- 失败区分 `no_browser`、`unsupported_format`、`capability_unavailable`、`cancelled`、`timeout`、`capture_failed`、`invalid_request`；取消与 finally 清理本会话 browser/server/profile。

## 备选方案

**继续只用 `--screenshot=file://...`。** 无法拦截动态网络、多帧或就绪诊断；与离线证据要求冲突。

**引入 Puppeteer/Playwright 生产依赖。** 体积与更新面过大；本任务所需 CDP 面可用 Node WebSocket 覆盖。

**无浏览器时静默跳过预览并宣称成功。** 会把观察缺口伪装成已验证视觉结论。

## 影响

- 扩展 [结果页主路径与 openable 视觉 media 门禁](./2026-09-18-result-paths-and-visual-media-gate.md) 的截图路径：HTML/SVG 走受控渲染。
- Comparison 工具面新增 `render_artifact` / `preview_report`；生产挂载等待 B3 catalog。
- 架构事实见 [证据与 Comparison](../../architecture/evidence-and-comparison.md)。

## 验证

- `test/application/artifact-renderer.test.ts`：fake 多帧、校验、取消、bundle 路径逃逸；opt-in 真浏览器双帧、HTTP/WebSocket 与 Worker·SW 出网阻断。
- `test/application/comparison-render-tools.test.ts`：工具注册、去重 shortRef、preview digest、`review-*` 与 `media-*` 命名空间分离。
- `test/application/comparison-openable-media.test.ts`：仍可注入 `captureScreenshot`；默认生产路径经受控渲染器。
