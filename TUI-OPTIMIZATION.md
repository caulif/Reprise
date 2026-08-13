# Reprise TUI 实测优化方案

> 对照：`TUI-DESIGN.md`。阶段 A/B/C 已落地。本文记录验收结论与剩余非阻塞项。
>
> 证据：`docs/tui-audit/`（文本帧、HTML、截图）。`docs/` 被 `.gitignore` 忽略。

---

## 0. 结论

三阶段重构之后，又按本文 §4 把实测缺陷修完：

- **A**：单一 message 槽、compact 头部分行且 cwd 占满行宽、minimum wrap、error 去重、`joinColumns` 补齐、打开 `/config` 不再伪造 Unsaved。
- **B**：result / confirm / inspection / running 字段与度量、`countTurns`、sessions 选择重置、history `record unread`、kv 用可见宽度且长路径交给 panel wrap。
- **C**：生产 running 双 `ScrollView`、`workbench.ts` 展开、`FORCE_COLOR`、compact `→`→`->`、无色截断不再插入 `[0m...[0m]`、状态轨按段落换行、缺失 `from` 显示为 `created`。

公开 API 仍是 `CodexIntakeTui`（`start` / `run` / `preview` / `handleInput`）。

重跑：

```text
npm run check
node scripts/tui-visual-audit.mjs
node scripts/tui-audit-analyze.mjs
```

截图：对 `docs/tui-audit/html/*.html` 用 Chrome `--headless=new --screenshot`。总览页：`docs/tui-audit/index.html`。

---

## 1. 已对齐设计稿（不要再改回去）

- density：`<32` minimum / `32–77` compact ASCII / `≥78` Unicode 面板。
- `panel()` 用 `visibleWidth`；CJK inspection 不撑破框。
- Home `/run` 就绪度：`needs a TaskCase` / freeze 后 `✓`。
- 配置页脏标记 + 非法值只显示原因，不渲染原文。
- 运行页状态轨、来源着色、`+N` 详情行、`n/total`、头栏 `elapsed · turn · calls` + running pill。
- 结果页方案 B 固定句；Fidelity / Limitations 来自 `preflight`。
- 生产 `setLayoutRoot(VStack + HStack(ScrollView, ScrollView))`；mock 走 `addChild`。
- `?` 无 overlay 时把 `renderHelp()` 画进 body。

---

## 2. 阶段对照

| ID | 状态 | 落地 |
|---|---|---|
| H1 / E4 | 完成 | page renderer 不再打印 `view.message` |
| H2 / N6 | 完成 | compact 头两行；cwd 按剩余列宽截断，无 CSI 伪影 |
| H3 / H4 / I1 | 完成 | 去重 + `joinColumns` 补齐底边 |
| H6 | 完成 | 无 overlay 时 inline Keys 面板 |
| H7 / H8 | 完成 | `glyphs.empty` / `glyphs.sep` |
| C1 / C2 / C3 | 完成 | 保留 modelId；非法值下一行原因 |
| I2 / I3 / I4 / I5 | 完成 | 信号列间隙、选择重置、双列元数据、分区线 |
| Y1 | 完成 | `record unread` |
| R1–R6 | 完成 | preflight 解构、effort、fidelity、真实 source、Source 面板、空心步骤点 |
| N1–N5 / N7 | 完成 | `Input to Target`、双 ScrollView、`n/total`、头栏度量、compact `->` |
| E1–E3 | 完成 | Fidelity / Limitations / `path.join` / 宽屏双列 kv |
| 截断伪影 | 完成 | `truncateFit`：无色文本用纯 `...`，长路径 wrap |

---

## 3. 明确不做 / 非阻塞

- 新 slash 命令、聊天流、打分排名、`[o]` observational 仪式。
- chalk / 新运行时依赖。
- 改 `timeline.ts` 的 payload 形状（缺失 `from` 仍是 `State: ? → …`；**渲染层**显示 `created`）。
- 为了截图把密钥或非法 URL 原文画出来。
- **拆 `controller.ts`**：输入已按 `#homeInput` / `#configPageInput` / `#runningInput` 分方法；再拆文件需要把私有状态抬成公开宿主接口，收益低于回归风险。保持单类。
- FakeTerminal 抓不到 pi-tui overlay 的绝对定位写入；`?` / `/help` 用 `preview()` 与 mock `renderHelp()` 锁住。`[t]` Loader 只在 Viewport TUI 出现。

60 列 CJK 摘要、超长路径仍会按列宽截断或折行，这是密度限制，不是溢出。
