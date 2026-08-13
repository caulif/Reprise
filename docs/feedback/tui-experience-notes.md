# TUI 体验问题记录

> 用途：记录用户体验过程中的原始反馈与可核对的界面事实。此文件在体验阶段只记录，不包含实现方案，不触发代码修改。

## 2026-08-12 · 记录 001

- **用户原话**：`tui内编辑配置太难用了，不是人用的`
- **场景**：在 Reprise Harness API 的 `/config` 配置界面编辑 `base URL`。
- **证据**：用户提供截图 `C:\Users\15893\AppData\Local\Temp\codex-clipboard-a58c70ca-fef1-40cf-8c45-c75f9d1ab865.png`。
- **可观察界面事实**：
  - 配置项以紧凑的纯文本行列表呈现；焦点仅由 `>` 指示。
  - 当前处于字段编辑状态，但屏幕同时保留字段列表、说明文字与快捷键说明。
  - 快捷键同时使用方向键、Enter、`s`、`t`、Esc；说明分散在多行，且当前操作与保存/测试动作并列。
  - 界面没有显式的表单步骤、字段输入区域边界或完成路径提示。
- **用户影响（待后续体验继续验证）**：配置第三方 API 的首要路径不直观，用户难以判断当前输入焦点、下一步操作及保存是否会联网。
- **状态**：已修复（2026-08-13）。字段编辑现使用独立输入框，默认从空白替换值开始；`Enter` 应用、`Esc` 放弃、`Ctrl+A` 清空，保存与联通性测试保持明确分离。

## 2026-08-12 · 体验前本地配置（非问题）

- 为绕过已记录的 `/config` 可用性问题，已由助手直接创建本地配置：`.reprise/harness-model.json`。
- Harness（系统 Agent）：OpenAI-compatible `https://api.dzzzz.cf`，模型 `gpt-5.6-terra`，effort `medium`，密钥引用 `env:OPENAI_API_KEY`。
- 被测候选：现有 TUI workflow 固定为 `gpt-5.6-luna`，并在运行摘要中标注 high reasoning；其实际运行时解析仍由 Codex runtime preflight 决定。
- 真实密钥未写入任何项目文件。用户提供的密钥不在记录中复述。
from pathlib import Path
p=Path('src/products/codex/sessions.ts')
s=p.read_text()
old="""  const summaries = await Promise.all((await rolloutPaths(resolve(sessionsRoot))).map(inspectCodexSession));
  return summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit);"""
new="""  const paths = await rolloutPaths(resolve(sessionsRoot));
  const summaries = await Promise.all(paths.map(inspectForDiscovery));
  return summaries.filter((summary): summary is CodexSessionSummary => summary !== undefined).sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit);"""
assert old in s
s=s.replace(old,new)
needle="""/** Checks one complete rollout before a user chooses to freeze it. */
export async function inspectCodexSession(sourcePath: string): Promise<CodexSessionInspection> {"""
insert="""/** Discovery skips unreadable or oversized local rollouts so one archival file cannot break the whole TUI. */
async function inspectForDiscovery(sourcePath: string): Promise<CodexSessionSummary | undefined> {
  try { return await inspectCodexSession(sourcePath); } catch { return undefined; }
}

/** Checks one complete rollout before a user chooses to freeze it. */
export async function inspectCodexSession(sourcePath: string): Promise<CodexSessionInspection> {"""
assert needle in s
s=s.replace(needle,insert)
p.write_text(s)

p=Path('src/tui/codex-intake.ts')
s=p.read_text()
old="""    if (matchesKey(data, 'backspace')) {
      this.#configBuffer = this.#configBuffer.slice(0, -1);
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {"""
new="""    if (matchesKey(data, 'ctrl+a')) {
      this.#configBuffer = '';
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'backspace')) {
      this.#configBuffer = this.#configBuffer.slice(0, -1);
      this.#render();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {"""
assert old in s
s=s.replace(old,new,1)
p.write_text(s)
PY
@'

## 2026-08-13 · 记录 002（已纳入修复范围）

- **用户原话**：`请你自己全流程所有操作都测试一遍，过程中截图，并修复问题，直到可以流畅正常使用，此外这个tui太丑了，能不能好看一点`
- **证据**：用户提供启动截图 `C:\Users\15893\AppData\Local\Temp\codex-clipboard-21fba763-93bc-4f85-84ac-7c887c44c7d5.png`。
- **已复现问题**：`/intake` 在发现本地 Codex sessions 时，单个超过 64 MiB 的 rollout 触发未处理异常，整个 TUI 退出。
- **纳入范围**：会话发现逐文件容错；配置字段编辑的清空方式；TUI 的层级、边框和窄终端输出可读性；五个命令的受控端到端验证与截图审查。


## 2026-08-13 · 本轮受控验收与截图审查

- **范围**：`/help`、`/config` 编辑态、`/intake` 列表与审阅、`/run` 的 preflight/确认/运行时间线、`/history`。
- **方法**：使用临时本地 fixture、假的 Runtime/Workflow 和显式的事件流驱动真实 TUI 状态机；没有读取真实 Codex 会话、没有调用外部 Provider、没有使用真实密钥。
- **截图证据**：`docs/evidence/tui-acceptance-2026-08-13/`。图像由上述状态机渲染帧生成后保存，用于可重复的视觉审查，而非含私人数据的桌面截图。
- **发现并修复**：配置页 `Esc` 在字段未编辑时没有返回 Home，导致从 `/config` 继续输入 `/intake` 会被当作字段值。现已由配置页优先处理 `Esc` 返回 Home，并补齐页面调度顺序，避免 source/preflight/confirm 由全局 Escape 提前吞掉键盘输入。
- **视觉审查结论**：宽终端采用稳定的 76 列边框、清晰的顶部上下文、页面标题、主操作和键盘提示；窄终端移除框线并转为 ASCII/紧凑文本，避免边框被折行破坏。没有为美化引入主题框架或额外依赖。
- **限制**：本地运行时的最终字体、色彩、窗口尺寸取决于用户终端；本轮未执行真实 Provider probe 或真实候选实验，避免未经确认产生第三方调用与成本。
