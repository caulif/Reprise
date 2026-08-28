import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CodexIntakeTui } from "../src/tui/intake-app.js";
import {
  defaultHarnessModelConfig,
  saveHarnessModelConfig,
} from "../src/infrastructure/harness-model-config.js";
import { mockTui, pageHtml, waitFor } from "./tui-audit-lib.js";

Object.defineProperty(process.stdout, "isTTY", {
  configurable: true,
  value: true,
});
process.env.TERM =
  process.env.TERM && process.env.TERM !== "dumb"
    ? process.env.TERM
    : "xterm-256color";
delete process.env.NO_COLOR;

const execFileAsync = promisify(execFile);
const outDir = join(process.cwd(), "docs", "tui-full-flow");
const framesDir = join(outDir, "frames");
const htmlDir = join(outDir, "html");
const shotDir = join(outDir, "screenshots");

type Capture = { name: string; width: number; rows: number; note: string };

function enterCommand(app: CodexIntakeTui, command: string) {
  app.handleInput(command);
  app.handleInput("\r");
}

function chromePath() {
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(
      process.env.LOCALAPPDATA ?? "",
      "Google\\Chrome\\Application\\chrome.exe",
    ),
  ].find((path) => existsSync(path));
}

async function captureScreenshots(captures: readonly Capture[]) {
  const chrome = chromePath();
  if (!chrome) {
    console.log("chrome not found; skipping PNG screenshots");
    return 0;
  }
  let count = 0;
  for (const item of captures) {
    const html = join(htmlDir, `${item.name}.html`);
    const png = join(shotDir, `${item.name}.png`);
    const width = item.width >= 100 ? 1480 : 820;
    const height = Math.min(2400, 160 + item.rows * 22);
    try {
      await execFileAsync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--force-device-scale-factor=1",
          `--window-size=${width},${height}`,
          `--screenshot=${png}`,
          pathToFileURL(html).href,
        ],
        { timeout: 20_000 },
      );
      count += 1;
    } catch (error) {
      console.log(
        `screenshot failed for ${item.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return count;
}

async function main() {
  await rm(framesDir, { recursive: true, force: true });
  await rm(htmlDir, { recursive: true, force: true });
  await rm(shotDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });
  await mkdir(shotDir, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), "reprise-tui-full-flow-"));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, "data"), defaultHarnessModelConfig());
  await writeFile(
    join(sessionsRoot, "rollout-session-1.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-1", cwd: "C:/source", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Fix the bug." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Fixed it." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:04.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Verify the regression." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:05.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  await writeFile(
    join(sessionsRoot, "rollout-session-cjk.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-10T21:40:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-cjk",
          cwd: "C:/中文路径/reprise",
          cli_version: "0.1.0",
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-10T21:40:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "修复这个回归缺陷并验证测试全部通过",
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-10T21:40:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "已修复，并补了回归测试。" },
      }),
      JSON.stringify({
        timestamp: "2026-08-10T21:40:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );

  const captures: Capture[] = [];
  const push = async (
    name: string,
    width: number,
    frame: string,
    note: string,
  ) => {
    await writeFile(join(framesDir, `${name}.txt`), frame, "utf8");
    await writeFile(
      join(htmlDir, `${name}.html`),
      pageHtml(name, width, frame),
      "utf8",
    );
    captures.push({ name, width, rows: frame.split("\n").length, note });
  };

  const home = mockTui();
  const homeApp = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui: home.tui as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await homeApp.start();
  await push("01-home", 120, home.render(120), "封面");
  homeApp.handleInput("/");
  await push(
    "02-suggestions",
    120,
    home.render(120),
    "斜杠命令发现，应含 /find",
  );
  homeApp.handleInput("\u001b");
  enterCommand(homeApp, "/find");
  await push(
    "03-find-on-home",
    120,
    home.render(120),
    "封面 /find 应提示只在对照中可用",
  );
  homeApp.handleInput("?");
  await push("04-help", 120, home.render(120), "帮助 overlay");
  homeApp.handleInput("\u001b");
  enterCommand(homeApp, "/lang zh");
  await push("05-home-zh", 120, home.render(120), "中文封面，斜杠命令仍英文");
  enterCommand(homeApp, "/lang en");

  enterCommand(homeApp, "/config");
  await waitFor(
    () => /Harness connection|Settings/.test(home.render(120)),
    { frame: () => home.render(120) },
  );
  await push("06-config", 120, home.render(120), "设置 overlay");
  homeApp.handleInput("\x1b");

  enterCommand(homeApp, "/intake");
  await waitFor(
    () => /Choose a project/.test(home.render(120)),
    { frame: () => home.render(120) },
  );
  await push("07-projects", 120, home.render(120), "导入：项目列表");
  homeApp.handleInput("\r");
  await waitFor(
    () => /Fix the bug/.test(home.render(120)),
    { frame: () => home.render(120) },
  );
  await push("08-sessions", 120, home.render(120), "导入：会话列表");
  homeApp.handleInput("\r");
  await waitFor(
    () => /is current/.test(home.render(120)),
    { frame: () => home.render(120) },
  );
  await push("10-home-with-task", 120, home.render(120), "选会话后已冻结任务的封面");

  const historyRoot = join(root, "history-data");
  const casesRoot = join(historyRoot, "cases", "case-history");
  const experimentsRoot = join(historyRoot, "experiments", "exp-history");
  await mkdir(casesRoot, { recursive: true });
  await mkdir(join(experimentsRoot, "runs", "run-history"), {
    recursive: true,
  });
  const taskCase = {
    schemaVersion: 1,
    caseId: "case-history",
    source: { productId: "codex", sessionId: "session-history" },
    initialInput: {
      id: "input-history",
      role: "user",
      text: "Inspect a focused regression.",
    },
    transcript: [
      {
        id: "input-history",
        role: "user",
        text: "Inspect a focused regression.",
      },
    ],
    historicalEvents: [],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: {
      packVersion: "1",
      importedAt: "2026-08-11T00:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  await writeFile(join(casesRoot, "case.json"), JSON.stringify(taskCase));
  await writeFile(
    join(experimentsRoot, "experiment.json"),
    JSON.stringify({
      spec: {
        experimentId: "exp-history",
        taskCaseId: "case-history",
        candidates: [
          {
            candidateId: "codex-history",
            productId: "codex",
            requestedModel: "gpt-history",
          },
        ],
        recovery: {
          providerId: "provider",
          requestedModel: "model",
          budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
        },
        controller: {
          providerId: "provider",
          requestedModel: "model",
          budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
        },
        comparison: {
          providerId: "provider",
          requestedModel: "model",
          budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
        },
        runPolicy: {
          wallClockMs: 1,
          maxTargetTurns: 1,
          maxModelCalls: 1,
          turnTimeoutMs: 1,
          maxConsecutiveNoProgress: 1,
        },
        outputRoot: experimentsRoot,
      },
      runIds: ["run-history"],
    }),
  );
  await writeFile(
    join(experimentsRoot, "runs", "run-history", "record.json"),
    JSON.stringify({
      schemaVersion: 1,
      attempt: {
        schemaVersion: 1,
        runId: "run-history",
        experimentId: "exp-history",
        caseId: "case-history",
        candidate: {
          candidateId: "codex-history",
          productId: "codex",
          requestedModel: "gpt-history",
        },
        policy: {
          wallClockMs: 1,
          maxTargetTurns: 1,
          maxModelCalls: 1,
          turnTimeoutMs: 1,
          maxConsecutiveNoProgress: 1,
        },
        createdAt: "2026-08-11T01:00:00.000Z",
      },
      outcome: {
        termination: {
          kind: "completed",
          code: "completed.controller_satisfied",
        },
        cleanup: { status: "complete" },
      },
    }),
  );
  const history = mockTui();
  const historyApp = new CodexIntakeTui({
    dataDir: historyRoot,
    sessionsRoot,
    tui: history.tui as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await historyApp.start();
  enterCommand(historyApp, "/history");
  await waitFor(
    () => /Recent experiments/.test(history.render(120)),
    { frame: () => history.render(120) },
  );
  await push("11-history", 120, history.render(120), "历史 overlay");

  const fullPublicResponse = `${Array.from({ length: 40 }, (_, index) => `public response line ${index + 1}`).join("\n")}\nPUBLIC_DETAIL_END`;
  let releasePreflight: (() => void) | undefined;
  let releaseRecovery: (() => void) | undefined;
  let releaseCopy: (() => void) | undefined;
  let releaseStart: (() => void) | undefined;
  let resolveResult: ((value: unknown) => void) | undefined;
  const workflow = {
    candidate: {
      candidateId: "codex-luna-high",
      productId: "codex",
      requestedModel: "gpt-5.6-luna",
    },
    policy: {
      wallClockMs: 30 * 60_000,
      maxTargetTurns: 4,
      maxModelCalls: 3,
      turnTimeoutMs: 10 * 60_000,
      maxConsecutiveNoProgress: 1,
    },
    preflight: async () => {
      await new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      return {
        sourceBaseline: "available",
        resolved: {
          productId: "codex",
          executable: "fixture",
          requestedModel: "gpt-5.6-luna",
          resolvedModel: "gpt-5.6-luna",
        },
        comparisonClass: "observational",
        limitations: ["fingerprint differs"],
        workspace: {
          fileCount: 111,
          totalBytes: Math.round(66.4 * 1024 * 1024),
          largestFileBytes: 1024,
          blockedReasons: [],
        },
      };
    },
    recover: async () => {
      await new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      return {
        baseline: { match: "recovered", warnings: [], mode: "canonical" },
        staging: { recoveryId: "audit-recovery" },
        provider: { discardRecovery: async () => undefined },
      };
    },
    start: async (input: { onEvent: (event: unknown) => void }) => {
      await new Promise<void>((resolve) => {
        releaseCopy = resolve;
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 1,
        eventId: "event-1",
        occurredAt: "2026-08-11T00:10:00.000Z",
        type: "run.state_changed",
        payload: { to: "launching" },
        checksum: "a".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 2,
        eventId: "event-2",
        occurredAt: "2026-08-11T00:10:00.000Z",
        type: "input.submitted",
        payload: { turnIndex: 0, text: "Fix the failing test." },
        checksum: "a".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 3,
        eventId: "event-3",
        occurredAt: "2026-08-11T00:10:00.500Z",
        type: "codex.turn_started",
        payload: {},
        checksum: "a".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 4,
        eventId: "event-4",
        occurredAt: "2026-08-11T00:10:01.000Z",
        type: "controller.decision",
        payload: {
          status: "completed",
          sessionId: "controller-1",
          value: {
            type: "send",
            rationale: "One check remains.",
            message: "Run the focused test.",
          },
        },
        checksum: "b".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 5,
        eventId: "event-5",
        occurredAt: "2026-08-11T00:10:01.500Z",
        type: "codex.item_completed",
        payload: {
          item: {
            type: "commandExecution",
            command:
              '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "Get-ChildItem | Format-Table Mode,Length,LastWriteTime,Name"',
            status: "completed",
            cwd: "C:\\\\work",
            exitCode: 0,
            durationMs: 476,
            aggregatedOutput: [
              "Mode  Length LastWriteTime         Name",
              "----  ------ -------------         ----",
              "-a---   1200 8/13/2026 12:00:00 AM  file-1.txt",
            ].join("\n"),
          },
        },
        checksum: "c".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 6,
        eventId: "event-6",
        occurredAt: "2026-08-11T00:10:02.000Z",
        type: "codex.item_completed",
        payload: { item: { type: "agentMessage", text: fullPublicResponse } },
        checksum: "d".repeat(64),
      });
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return {
        cancel: async () => {},
        result: new Promise((resolve) => {
          resolveResult = resolve;
        }),
      };
    },
  };

  const run = mockTui(32);
  const runApp = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui: run.tui as never,
    workflow: workflow as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
  });
  await runApp.start();
  enterCommand(runApp, "/intake");
  await waitFor(
    () => /Choose a project/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  runApp.handleInput("\r");
  await waitFor(
    () => /Fix the bug/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  runApp.handleInput("\r");
  await waitFor(
    () => /Recovering session|Preparing recovery environment|Preparing replay|TaskCase frozen|Starting environment recovery/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  await push(
    "12-preflight-wait",
    120,
    run.render(120),
    "选会话后直接开始恢复",
  );
  releasePreflight?.();
  await waitFor(
    () => /Preparing replay|Recovering session/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  releaseRecovery?.();
  await waitFor(
    () => /Start isolated Codex Candidate/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  runApp.handleInput("\r");
  await waitFor(
    () => /Copy isolated|Preparing replay|To Codex/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  await push("15-preparing", 120, run.render(120), "准备进度");
  releaseCopy?.();
  await waitFor(
    () => /To Codex|Codex/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  releaseStart?.();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await push("16-running", 120, run.render(120), "对照画布");
  runApp.handleInput("/");
  for (const ch of "public response") runApp.handleInput(ch);
  await push("17-running-find", 120, run.render(120), "画布内查找，只留匹配块");
  runApp.handleInput("\x1b");
  runApp.handleInput("\u001b[A");
  runApp.handleInput("o");
  await push("18-viewer", 120, run.render(120), "全文 overlay");
  runApp.handleInput("\x1b");
  runApp.handleInput("\u0007");
  await push("19-actors", 120, run.render(120), "Actors pane");
  runApp.handleInput("\x1b");
  resolveResult?.({
    reportPath: join(root, "data", "experiments", "fixture", "report.html"),
    experimentRoot: join(root, "data", "experiments", "fixture"),
    preflight: {
      sourceBaseline: "available",
      resolved: {
        productId: "codex",
        executable: "fixture",
        requestedModel: "gpt-5.6-luna",
        resolvedModel: "gpt-5.6-luna",
      },
      comparisonClass: "observational",
      limitations: ["fingerprint differs"],
    },
    record: {
      attempt: { runId: "run-1" },
      outcome: {
        termination: {
          kind: "completed",
          code: "completed.controller_satisfied",
        },
        cleanup: { status: "complete" },
      },
    },
    decision: {
      status: "completed",
      value: { type: "done" },
      usedFallback: false,
    },
    comparison: { result: { status: "completed", usedFallback: false } },
  });
  await waitFor(
    () => /Experiment finished/.test(run.render(120)),
    { frame: () => run.render(120) },
  );
  await push("20-result", 120, run.render(120), "结果留在画布");
  runApp.handleInput("/");
  for (const ch of "Get-ChildItem") runApp.handleInput(ch);
  await push("21-result-find", 120, run.render(120), "结果页画布查找");

  const err = mockTui();
  const sessionsFile = join(root, "sessions-file");
  await writeFile(sessionsFile, "not a directory");
  const errApp = new CodexIntakeTui({
    dataDir: join(root, "data-err"),
    sessionsRoot: sessionsFile,
    tui: err.tui as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await errApp.start();
  enterCommand(errApp, "/intake");
  await waitFor(
    () => /ENOTDIR|not a directory|Error/i.test(err.render(120)),
    { frame: () => err.render(120) },
  );
  await push("22-error", 120, err.render(120), "错误卡片");

  const shots = await captureScreenshots(captures);
  const index = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Reprise 全流程走查</title>
<style>body{margin:24px;background:#0b1220;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui}a{color:#93c5fd}img{margin:8px 0 20px;border:1px solid #1f2937;border-radius:8px;background:#111827;max-width:100%} li{margin:18px 0} .note{color:#9ca3af}</style>
</head><body><h1>Reprise TUI 全流程走查</h1>
<p>${captures.length} 帧 · ${shots} 张截图</p>
<ol>
${captures.map((item) => `<li><a href="html/${item.name}.html">${item.name}</a> · ${item.width}×${item.rows}<div class="note">${item.note}</div><a href="screenshots/${item.name}.png"><img src="screenshots/${item.name}.png" alt="${item.name}" width="${item.width >= 100 ? 920 : 480}"></a></li>`).join("\n")}
</ol></body></html>`;
  await writeFile(join(outDir, "index.html"), index, "utf8");
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        captures,
        shots,
        index: pathToFileURL(join(outDir, "index.html")).href,
      },
      null,
      2,
    ),
  );
  console.log(
    `wrote ${captures.length} frames and ${shots} screenshots to ${outDir}`,
  );
  await rm(root, { recursive: true, force: true });
}

await main();
