import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sha256, writeAtomic } from "../core/identity.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";
import { ManagedBrowser } from "../infrastructure/managed-browser.js";
import type { ComparisonRenderCatalogPort } from "./comparison-render-tools.js";
import { ARTIFACT_RENDERER_VERSION } from "../infrastructure/artifact-render-types.js";

const OpenSchema = Type.Object({ sourceRef: Type.String({ minLength: 1, maxLength: 128 }),
  viewport: Type.Optional(Type.Object({ width: Type.Integer({ minimum: 320, maximum: 2560 }),
    height: Type.Integer({ minimum: 240, maximum: 2000 }) })) });
const PageSchema = Type.Object({ pageId: Type.String({ minLength: 1, maxLength: 64 }) });
const ActionSchema = Type.Object({ pageId: PageSchema.properties.pageId,
  action: Type.Union([Type.Literal("click"), Type.Literal("fill")]),
  selector: Type.String({ minLength: 1, maxLength: 512 }), value: Type.Optional(Type.String({ maxLength: 4096 })) });

function textResult(value: Record<string, unknown>): AgentToolResult {
  return { content: JSON.stringify(value), details: value };
}

export function createComparisonBrowserTools(input: {
  browser?: ManagedBrowser;
  catalog: ComparisonRenderCatalogPort;
  attemptRoot: string;
  allowBinary?: boolean;
}): AgentToolDefinition[] {
  const browser = input.browser;
  return [
    { name: "browser_open", description: "Open a registered frozen source in an isolated managed browser page. Only the sourceRef is accepted; side and version come from the Host catalog.",
      parameters: OpenSchema, async execute(params, signal) {
        if (!Value.Check(OpenSchema, params)) return textResult({ status: "invalid_request" });
        if (!browser) return textResult({ status: "unavailable", reason: "No verified browser capability." });
        const source = await input.catalog.resolveSource(params.sourceRef);
        if (!source) return textResult({ status: "unknown_source", sourceRef: params.sourceRef });
        try {
          const opened = await browser.open({ bundleRoot: source.bundleRoot, entryRelativePath: source.entryRelativePath,
            sourceRef: source.sourceRef, side: source.side, sourceHash: source.contentHash,
            viewport: params.viewport ?? { width: 1280, height: 800 }, signal });
          return textResult({ status: "ok", ...opened, sourceRef: source.sourceRef, side: source.side,
            sourceHash: source.contentHash, origin: source.origin });
        } catch (error) { return textResult({ status: "load_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "browser_snapshot", description: "Read text and page diagnostics from a managed pageId.", parameters: PageSchema,
      async execute(params) {
        if (!Value.Check(PageSchema, params)) return textResult({ status: "invalid_request" });
        if (!browser) return textResult({ status: "unavailable" });
        try { return textResult({ status: "ok", ...await browser.snapshot(params.pageId) }); }
        catch (error) { return textResult({ status: "page_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "browser_action", description: "Click or fill a locator on a managed page, then return its current text and diagnostics.", parameters: ActionSchema,
      async execute(params) {
        if (!Value.Check(ActionSchema, params)) return textResult({ status: "invalid_request" });
        if (!browser) return textResult({ status: "unavailable" });
        try { return textResult({ status: "ok", ...await browser.action(params.pageId, params.action, params.selector, params.value) }); }
        catch (error) { return textResult({ status: "action_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "browser_screenshot", description: "Capture the current managed page. Host binds the image to its opened source and registers a derived media ref.", parameters: PageSchema,
      async execute(params) {
        if (!Value.Check(PageSchema, params)) return textResult({ status: "invalid_request" });
        if (!browser) return textResult({ status: "unavailable" });
        try {
          const shot = await browser.screenshot(params.pageId);
          const digest = sha256(shot.bytes);
          const root = join(input.attemptRoot, "scratch", "browser");
          await mkdir(root, { recursive: true });
          const path = join(root, `${digest}.png`);
          await writeAtomic(path, shot.bytes);
          const registered = await input.catalog.registerDerivedMedia({ side: shot.side as "baseline" | "candidate" | "host" | "derived",
            pngPath: path, label: `browser:${shot.sourceRef}`, sourceRef: shot.sourceRef, contentHash: digest,
            kind: "artifact_preview", derivation: { rendererVersion: ARTIFACT_RENDERER_VERSION,
              viewport: { ...shot.viewport, scale: 1 }, sampleTimeMs: 0,
              actualTimeMs: shot.elapsedMs, capturedAt: shot.capturedAt,
              sourceHash: shot.sourceHash, finalUrl: shot.finalUrl, urlStateOmitted: shot.urlStateOmitted,
              errorsOmitted: shot.errorsOmitted, actions: shot.actions } });
          if (!registered.ok) return textResult({ status: "capture_failed", code: registered.code, message: registered.message });
          const result = { status: "ok", sourceRef: shot.sourceRef, side: shot.side, sourceHash: shot.sourceHash,
            finalUrl: shot.finalUrl, urlStateOmitted: shot.urlStateOmitted,
            capturedAt: shot.capturedAt, elapsedMs: shot.elapsedMs,
            actions: shot.actions, errors: shot.errors, errorsOmitted: shot.errorsOmitted,
            media: { shortRef: registered.shortRef, mediaRef: registered.mediaRef, contentHash: digest } };
          const content = JSON.stringify(result);
          return { content, details: result, contentBlocks: [{ type: "text", text: content },
            ...(input.allowBinary === false ? [] : [{ type: "image" as const,
              data: shot.bytes.toString("base64"), mimeType: "image/png" }]) ] };
        } catch (error) { return textResult({ status: "capture_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "browser_close", description: "Close an attempt-scoped managed page and its local bundle server.", parameters: PageSchema,
      async execute(params) {
        if (!Value.Check(PageSchema, params)) return textResult({ status: "invalid_request" });
        if (!browser) return textResult({ status: "unavailable" });
        try { await browser.closePage(params.pageId); return textResult({ status: "closed" }); }
        catch (error) { return textResult({ status: "page_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
