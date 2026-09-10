import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { createExperimentWorkflow } from "../application/experiment-workflow.js";
import { importPacks } from "../application/intake-catalog.js";
import { createProductLookup, productPacks } from "../products/index.js";
import type { IntakeTui, IntakeTuiOptions } from "./intake-tui.js";
import { Workbench } from "./workbench.js";

function sourceHistoryWorkflow(packs: IntakeTui["packs"], dataDir: string, now: () => string) {
  return createExperimentWorkflow({
    dataDir,
    lookup: createProductLookup(packs),
    now,
    agents: async () => {
      throw new Error("Harness agents are required to start an experiment.");
    },
  });
}

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
  const history = sourceHistoryWorkflow(target.packs, options.dataDir, target.now);
  target.canStartExperiment = Boolean(options.workflow);
  target.workflow = options.workflow
    ? {
        ...options.workflow,
        sourceRoot: (productId, sessionsRoots) => history.sourceRoot(productId, sessionsRoots),
        discoverSource: (productId, query) => history.discoverSource(productId, query),
        inspectSource: (ref) => history.inspectSource(ref),
        freezeSource: (request) => history.freezeSource(request),
      }
    : history;
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
