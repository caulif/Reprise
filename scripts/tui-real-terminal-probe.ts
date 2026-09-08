import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { getCapabilities } from "@earendil-works/pi-tui";
import { CodexIntakeTui } from "../src/tui/intake-app.js";
import { fileLink } from "../src/tui/format.js";
import { DISABLE_MOUSE_REPORTING } from "../src/tui/terminal-guard.js";

if (process.env.REPRISE_REAL_TERMINAL !== "1") {
  throw new Error("Set REPRISE_REAL_TERMINAL=1 to probe a real terminal.");
}
if (!process.stdout.isTTY) {
  throw new Error("Need a real TTY (for example Windows Terminal).");
}
const outPath = process.argv[2];
if (!outPath || !isAbsolute(outPath)) {
  throw new Error("Usage: probe:tui-terminal <absolute-report.json>");
}

const writes: string[] = [];
let viewportWheel = 0;
let viewportMouse = 0;
const dataDir = await mkdtemp(resolve(tmpdir(), "reprise-tui-probe-"));
const app = new CodexIntakeTui({
  dataDir,
  privacy: { allowModelText: false, allowBinary: false, redactions: [] },
});
const viewport = app.tui as unknown as {
  parseWheelEvent?: (data: string) => unknown;
  parseSgrMouseEvent?: (data: string) => unknown;
};
const parseWheel = viewport.parseWheelEvent?.bind(viewport);
if (parseWheel && viewport.parseWheelEvent) {
  viewport.parseWheelEvent = (data: string) => {
    const event = parseWheel(data);
    if (event) viewportWheel += 1;
    return event;
  };
}
const parseMouse = viewport.parseSgrMouseEvent?.bind(viewport);
if (parseMouse && viewport.parseSgrMouseEvent) {
  viewport.parseSgrMouseEvent = (data: string) => {
    const event = parseMouse(data);
    if (event) viewportMouse += 1;
    return event;
  };
}
const terminal = app.tui as { terminal?: { write?: (data: string) => void } };
const originalWrite = terminal.terminal?.write?.bind(terminal.terminal);
if (terminal.terminal && originalWrite) {
  terminal.terminal.write = (data: string) => {
    writes.push(data);
    originalWrite(data);
  };
}
await app.start();
let rawStdin = 0;
let imeLike = 0;
process.stdin.on("data", (chunk: string) => {
  rawStdin += 1;
  if (/[^\x00-\x7F]/.test(chunk) || /[\u4e00-\u9fff]/.test(chunk)) imeLike += 1;
});
await app.setLocale("zh");
app.setHomeMessage("请在本窗口滚轮、拖选，并用输入法输入中文");
await mkdir(dirname(outPath), { recursive: true });
await writeFile(`${outPath}.ready`, "ready\n");
const waitMs = Number.parseInt(process.env.REPRISE_TUI_PROBE_WAIT_MS ?? "0", 10);
await delay(Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0);
app.setMouseReporting(false);
app.setMouseReporting(true);
const frame = app.preview(100);
const linked = fileLink("probe", dataDir);
app.close();
await app.closing;
const blob = writes.join("");

const report = {
  schemaVersion: 5,
  platform: process.platform,
  term: process.env.TERM ?? "",
  wtSession: Boolean(process.env.WT_SESSION),
  tty: true,
  rows: app.tui.terminal?.rows,
  hyperlinks: Boolean(getCapabilities().hyperlinks),
  osc8: linked.includes("\x1b]8;;"),
  mouseOffWritten: blob.includes(DISABLE_MOUSE_REPORTING),
  zhHome: frame.includes("导入历史"),
  zhMessage: frame.includes("输入法") || frame.includes("中文路径测试"),
  viewportWheel,
  viewportMouse,
  rawStdin,
  imeLike,
  waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0,
  closed: app.closed,
};
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
