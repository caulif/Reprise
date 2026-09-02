import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { productPacks } from "../products/index.js";
import type { CodexIntakeTui, CodexIntakeTuiOptions } from "./intake-tui.js";
import { Workbench } from "./workbench.js";

function wireCodexIntakeTui(target: CodexIntakeTui, options: CodexIntakeTuiOptions): void {
  target.dataDir = options.dataDir;
  target.sessionsRoot = options.sessionsRoot;
  target.packs = options.packs ?? (options.pack ? [options.pack] : productPacks);
  const legacyPack =
    options.pack ??
    target.packs.find((pack) => pack.manifest.productId === "codex") ??
    (target.packs.length === 1 ? target.packs[0] : undefined);
  const legacyRoot =
    options.sessionsRoot && legacyPack ? { [legacyPack.manifest.productId]: options.sessionsRoot } : {};
  target.sessionsRoots = { ...legacyRoot, ...options.sessionsRoots };
  target.privacy = options.privacy;
  target.tui =
    options.tui ??
    new TuiAltScreen(new ProcessTerminal(), undefined, undefined, {
      openUrl: (url) => {
        target.openFileUrl(url);
      },
    });
  target.workbench = new Workbench(
    () => target.view(),
    () => target.viewport(),
  );
  target.now = options.now ?? (() => new Date().toISOString());
  target.nowMs = options.nowMs ?? Date.now;
  target.displayCwd = options.displayCwd ?? process.cwd();
  target.piModels = options.piModels;
  target.workflow = options.workflow;
  target.autoCompare = Boolean(options.autoCompare);
  target.queueTimelineRender =
    options.queueTimelineRender ??
    ((callback: () => void) => {
      setTimeout(callback, 16);
    });
}

export function initializeCodexIntakeTui(target: CodexIntakeTui, options: CodexIntakeTuiOptions): void {
  wireCodexIntakeTui(target, options);
}
