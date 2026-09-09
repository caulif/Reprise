import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { productPacks } from "../products/index.js";
import { importPacks } from "../products/pack-access.js";
import type { IntakeTui, IntakeTuiOptions } from "./intake-tui.js";
import { Workbench } from "./workbench.js";

function wireIntakeTui(target: IntakeTui, options: IntakeTuiOptions): void {
  target.dataDir = options.dataDir;
  target.sessionsRoot = options.sessionsRoot;
  target.packs = options.packs ?? (options.pack ? [options.pack] : productPacks);
  const importCapable = importPacks(target.packs);
  const unnamedOwner = options.pack ?? importCapable[0];
  const legacyRoot =
    options.sessionsRoot && unnamedOwner ? { [unnamedOwner.manifest.productId]: options.sessionsRoot } : {};
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

export function initializeIntakeTui(target: IntakeTui, options: IntakeTuiOptions): void {
  wireIntakeTui(target, options);
}
