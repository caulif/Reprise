import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { startBundleStaticServer, type BundleStaticServer } from "./artifact-bundle-server.js";

type OpenPage = {
  page: Page;
  context: BrowserContext;
  server: BundleStaticServer;
  sourceRef: string;
  side: string;
  sourceHash: string;
  openedAt: number;
  errors: string[];
  errorsOmitted: { count: number };
  actions: { action: "click" | "fill"; selector: string; elapsedMs: number }[];
  unhealthy?: string;
};

export class ManagedBrowser {
  readonly #browserPath: string;
  #browser: Browser | undefined;
  #launching: Promise<Browser> | undefined;
  readonly #opening = new Set<Promise<unknown>>();
  readonly #pages = new Map<string, OpenPage>();
  #closing = false;

  constructor(browserPath: string) { this.#browserPath = browserPath; }

  async open(input: { bundleRoot: string; entryRelativePath: string; sourceRef: string; side: string; sourceHash: string;
    viewport: { width: number; height: number }; signal?: AbortSignal }): Promise<{ pageId: string; finalUrl: string; title: string; errors: string[]; errorsOmitted: number; urlStateOmitted: true }> {
    const operation = this.#open(input);
    this.#opening.add(operation);
    try { return await operation; }
    finally { this.#opening.delete(operation); }
  }

  async #open(input: { bundleRoot: string; entryRelativePath: string; sourceRef: string; side: string; sourceHash: string;
    viewport: { width: number; height: number }; signal?: AbortSignal }): Promise<{ pageId: string; finalUrl: string; title: string; errors: string[]; errorsOmitted: number; urlStateOmitted: true }> {
    if (input.signal?.aborted || this.#closing) throw new Error("Browser open cancelled or attempt closing.");
    if (this.#pages.size >= 8) throw new Error("Managed browser page limit reached.");
    this.#launching ??= chromium.launch({ executablePath: this.#browserPath, headless: true, timeout: 15_000 });
    this.#browser ??= await this.#launching;
    if (this.#closing) throw new Error("Browser attempt closed during launch.");
    const server = await startBundleStaticServer(input.bundleRoot);
    let context: BrowserContext | undefined;
    try {
      context = await this.#browser.newContext({ viewport: input.viewport, serviceWorkers: "block", acceptDownloads: false });
      const errors: string[] = [];
      const errorsOmitted = { count: 0 };
      const recordError = (error: string) => {
        if (errors.length < 64) errors.push(error);
        else errorsOmitted.count += 1;
      };
      const origin = server.origin;
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`)) return route.continue();
        recordError(`blocked_resource:${safeUrl(url)}`);
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket("**/*", (route) => {
        recordError(`blocked_websocket:${safeUrl(route.url())}`);
        return route.close();
      });
      const page = await context.newPage();
      context.on("page", (other) => {
        if (other !== page) void other.close().catch(() => recordError("extra_page_close_failed"));
      });
      page.on("popup", (popup) => { void popup.close().catch(() => recordError("popup_close_failed")); });
      page.on("download", (download) => {
        recordError("download_blocked");
        void download.cancel().catch(() => recordError("download_cancel_failed"));
      });
      const openedAt = Date.now();
      const entry: OpenPage = { page, context, server, sourceRef: input.sourceRef, side: input.side,
        sourceHash: input.sourceHash, openedAt, errors, errorsOmitted, actions: [] };
      page.on("pageerror", (error) => recordError(`page_error:${error.name}`));
      page.on("requestfailed", (request) => recordError(`request_failed:${safeUrl(request.url())}`));
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && !frame.url().startsWith(`${origin}/`)) entry.unhealthy = "Page left its registered source origin.";
      });
      page.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() && response.status() >= 400) {
          entry.unhealthy = `Navigation returned HTTP ${response.status()}.`;
        }
      });
      const abort = () => { void page.close().catch(() => recordError("abort_page_close_failed")); };
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        const target = new URL(input.entryRelativePath.split("/").map(encodeURIComponent).join("/"), `${origin}/`);
        const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (entry.unhealthy || !response || response.status() >= 400 || input.signal?.aborted || this.#closing) {
          throw new Error(entry.unhealthy ?? `Browser source did not load normally (status=${response?.status() ?? "none"}).`);
        }
        const pageId = randomUUID();
        const title = await page.title();
        if (this.#closing || input.signal?.aborted) throw new Error("Browser open cancelled or attempt closing.");
        this.#pages.set(pageId, entry);
        return { pageId, finalUrl: safeUrl(page.url()), title, errors: [...errors], errorsOmitted: errorsOmitted.count, urlStateOmitted: true };
      } finally {
        input.signal?.removeEventListener("abort", abort);
      }
    } catch (error) {
      const cleanup = await Promise.allSettled([context?.close(), server.close()]);
      const failures = cleanup.flatMap((item) => item.status === "rejected" ? [item.reason as unknown] : []);
      if (failures.length) throw new AggregateError([error, ...failures], "Managed browser open and cleanup failed.", { cause: error });
      throw error;
    }
  }

  async snapshot(pageId: string): Promise<{ pageId: string; finalUrl: string; title: string; text: string; errors: string[]; errorsOmitted: number; urlStateOmitted: true; unhealthy?: string }> {
    const current = this.#page(pageId);
    return { pageId, finalUrl: safeUrl(current.page.url()), title: await current.page.title(),
      text: (await current.page.locator("body").innerText()).slice(0, 24_000), errors: [...current.errors],
      errorsOmitted: current.errorsOmitted.count, urlStateOmitted: true,
      ...(current.unhealthy ? { unhealthy: current.unhealthy } : {}) };
  }

  async action(pageId: string, action: "click" | "fill", selector: string, value?: string): Promise<Awaited<ReturnType<ManagedBrowser["snapshot"]>>> {
    const current = this.#page(pageId);
    if (current.unhealthy) throw new Error(current.unhealthy);
    if (current.actions.length >= 128) throw new Error("Managed browser action limit reached.");
    if (!selector || selector.length > 512) throw new Error("Browser selector is empty or too long.");
    if (action === "click") await current.page.locator(selector).click({ timeout: 8_000 });
    else await current.page.locator(selector).fill(value ?? "", { timeout: 8_000 });
    current.actions.push({ action, selector, elapsedMs: Date.now() - current.openedAt });
    return this.snapshot(pageId);
  }

  async screenshot(pageId: string): Promise<{ bytes: Buffer; side: string; sourceRef: string; sourceHash: string;
    finalUrl: string; errors: string[]; errorsOmitted: number; urlStateOmitted: true; viewport: { width: number; height: number };
    capturedAt: string; elapsedMs: number; actions: readonly { action: "click" | "fill"; selector: string; elapsedMs: number }[] }> {
    const current = this.#page(pageId);
    if (current.unhealthy || !current.page.url().startsWith(`${current.server.origin}/`)) {
      throw new Error(current.unhealthy ?? "Browser page left its registered source origin.");
    }
    const viewport = current.page.viewportSize();
    if (!viewport) throw new Error("Browser viewport is unavailable.");
    const bytes = await current.page.screenshot({ type: "png" });
    return { bytes, side: current.side, sourceRef: current.sourceRef, sourceHash: current.sourceHash,
      finalUrl: safeUrl(current.page.url()), errors: [...current.errors], errorsOmitted: current.errorsOmitted.count, urlStateOmitted: true, viewport,
      capturedAt: new Date().toISOString(), elapsedMs: Date.now() - current.openedAt,
      actions: [...current.actions] };
  }

  async closePage(pageId: string): Promise<void> {
    const current = this.#page(pageId);
    this.#pages.delete(pageId);
    const closed = await Promise.allSettled([current.context.close(), current.server.close()]);
    const failures = closed.filter((item) => item.status === "rejected");
    if (failures.length) throw new Error(`Managed browser page cleanup failed (${failures.length} resources).`);
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#opening]);
    const closed = await Promise.allSettled([...this.#pages.keys()].map((pageId) => this.closePage(pageId)));
    this.#pages.clear();
    const browser = this.#browser;
    this.#browser = undefined;
    const final = browser ? await Promise.allSettled([browser.close()]) : [];
    const failures = [...closed, ...final].filter((item) => item.status === "rejected");
    if (failures.length) throw new Error(`Managed browser cleanup failed (${failures.length} resources).`);
  }

  #page(pageId: string): OpenPage {
    const page = this.#pages.get(pageId);
    if (!page) throw new Error("Unknown browser pageId for this comparison attempt.");
    return page;
  }
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 240);
  } catch {
    return "unavailable";
  }
}
