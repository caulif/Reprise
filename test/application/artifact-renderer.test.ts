import test from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBundleRequestPath, startBundleStaticServer } from "../../src/infrastructure/artifact-bundle-server.js";
import {
  createFakeArtifactRenderer,
  renderFrozenArtifact,
} from "../../src/infrastructure/artifact-renderer.js";
import { DEFAULT_RENDER_VIEWPORT } from "../../src/infrastructure/artifact-render-types.js";
import { sha256 } from "../../src/core/identity.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcJSAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const MINIMAL_PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("resolveBundleRequestPath rejects traversal and blocked names", () => {
  const root = "/tmp/bundle-root";
  assert.equal(resolveBundleRequestPath(root, "/index.html").ok, true);
  assert.equal(resolveBundleRequestPath(root, "/../etc/passwd").ok, false);
  assert.equal(resolveBundleRequestPath(root, "/subdir/../../etc/passwd").ok, false);
  assert.equal(resolveBundleRequestPath(root, "/.env").ok, false);
  assert.equal(resolveBundleRequestPath(root, "/").ok, false);
});

test("bundle static server serves local css and rejects blocked files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-bundle-server-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "index.html"), "<!doctype html><link rel=stylesheet href=app.css><title>x</title>", "utf8");
  await writeFile(join(root, "app.css"), "body{color:red}", "utf8");
  await writeFile(join(root, ".env"), "SECRET=1", "utf8");
  const server = await startBundleStaticServer(root);
  t.after(() => server.close());
  const html = await fetch(`${server.origin}/index.html`);
  assert.equal(html.status, 200);
  const css = await fetch(`${server.origin}/app.css`);
  assert.equal(css.status, 200);
  assert.equal(await css.text(), "body{color:red}");
  const envFile = await fetch(`${server.origin}/.env`);
  assert.equal(envFile.status, 403);
  const listing = await fetch(`${server.origin}/`);
  assert.equal(listing.status, 403);
});

test("fake renderer records protocol calls and distinct frames", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-fake-render-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "anim.html"), "<!doctype html><title>anim</title>", "utf8");
  const calls: number[][] = [];
  const fake = createFakeArtifactRenderer(async (request) => {
    calls.push([...request.sampleTimesMs]);
    await mkdir(request.outputRoot, { recursive: true });
    const frames = [];
    for (const [index, sampleTimeMs] of request.sampleTimesMs.entries()) {
      const pngPath = join(request.outputRoot, `frame-${index}.png`);
      const bytes = sampleTimeMs === 0 ? MINIMAL_PNG : MINIMAL_PNG_B;
      await writeFile(pngPath, bytes);
      frames.push({
        sampleTimeMs,
        actualTimeMs: sampleTimeMs,
        pngPath,
        byteLength: bytes.byteLength,
        contentHash: sha256(bytes),
      });
    }
    return {
      ok: true,
      frames,
      diagnostics: [],
      measured: { loadMs: 1, viewport: request.viewport, origin: "fake://bundle" },
    };
  });
  const result = await fake({
    bundleRoot: root,
    entryRelativePath: "anim.html",
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0, 500, 1000],
    outputRoot: join(root, "out"),
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(calls, [[0, 500, 1000]]);
  assert.equal(result.frames.length, 3);
  assert.notEqual(result.frames[0]?.contentHash, result.frames[1]?.contentHash);
});

test("renderFrozenArtifact rejects invalid viewport and unsupported formats", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-validate-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "notes.txt"), "hi", "utf8");
  const unsupported = await renderFrozenArtifact({
    bundleRoot: root,
    entryRelativePath: "notes.txt",
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0],
    outputRoot: join(root, "out"),
    signal: new AbortController().signal,
  });
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) return;
  assert.equal(unsupported.failure.kind, "unsupported_format");

  const badViewport = await renderFrozenArtifact({
    bundleRoot: root,
    entryRelativePath: "notes.txt",
    viewport: { width: 10, height: 10, scale: 1 },
    sampleTimesMs: [0],
    outputRoot: join(root, "out2"),
    signal: new AbortController().signal,
  });
  assert.equal(badViewport.ok, false);
  if (badViewport.ok) return;
  assert.equal(badViewport.failure.kind, "invalid_request");
});

test("renderFrozenArtifact copies raster without browser", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-raster-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "pic.png"), MINIMAL_PNG);
  const result = await renderFrozenArtifact({
    bundleRoot: root,
    entryRelativePath: "pic.png",
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0],
    outputRoot: join(root, "out"),
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.frames.length, 1);
  assert.equal(result.measured.origin, "raster-copy");
  assert.deepEqual(await readFile(result.frames[0]!.pngPath), MINIMAL_PNG);
});

test("renderFrozenArtifact rejects raster entry symlink without following target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-raster-symlink-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const outside = join(root, "outside-secret.txt");
  await writeFile(outside, "TOP_SECRET_CREDENTIAL=1\n", "utf8");
  const bundle = join(root, "bundle");
  const outputRoot = join(root, "out");
  await mkdir(bundle);
  try {
    await symlink(outside, join(bundle, "escape.png"));
  } catch {
    t.skip("symlink creation unavailable");
    return;
  }
  const result = await renderFrozenArtifact({
    bundleRoot: bundle,
    entryRelativePath: "escape.png",
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0],
    outputRoot,
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "invalid_request");
  assert.match(result.failure.message, /symlink rejected/i);
  await assert.rejects(() => access(join(outputRoot, "frame-000.png")));
});

test("renderFrozenArtifact rejects raster via intermediate directory symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-raster-dirlink-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const outsideDir = join(root, "outside-dir");
  await mkdir(outsideDir);
  const secretBytes = Buffer.from("TOP_SECRET_VIA_DIR=1\n", "utf8");
  await writeFile(join(outsideDir, "secret.png"), secretBytes);
  const bundle = join(root, "bundle");
  const outputRoot = join(root, "out");
  await mkdir(bundle);
  try {
    await symlink(outsideDir, join(bundle, "subdir"));
  } catch {
    t.skip("symlink creation unavailable");
    return;
  }
  const result = await renderFrozenArtifact({
    bundleRoot: bundle,
    entryRelativePath: "subdir/secret.png",
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0],
    outputRoot,
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "invalid_request");
  assert.match(result.failure.message, /escapes bundle root/i);
  const framePath = join(outputRoot, "frame-000.png");
  await assert.rejects(() => access(framePath));
  assert.deepEqual(await readFile(join(outsideDir, "secret.png")), secretBytes);
});

test("renderFrozenArtifact cancels before work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-cancel-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "x.html"), "<!doctype html>", "utf8");
  const controller = new AbortController();
  controller.abort();
  const result = await renderFrozenArtifact({
    bundleRoot: root,
    entryRelativePath: "x.html",
    viewport: DEFAULT_RENDER_VIEWPORT,
    sampleTimesMs: [0],
    outputRoot: join(root, "out"),
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "cancelled");
});

test("opt-in real browser captures two changing animation frames", async (t) => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== "1") {
    t.skip("set REPRISE_OPT_IN_BROWSER_RENDER=1 for live browser capture");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "reprise-render-live-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "anim.html"), `<!doctype html>
<html><body>
<div id="box" style="width:120px;height:120px;background:#100"></div>
<script>
  const box = document.getElementById('box');
  function paint(t) {
    const on = Math.floor(t / 500) % 2 === 1;
    box.style.background = on ? '#0f0' : '#100';
    requestAnimationFrame(() => paint(performance.now()));
  }
  requestAnimationFrame(() => paint(performance.now()));
</script>
</body></html>`, "utf8");
  const result = await renderFrozenArtifact({
    bundleRoot: root,
    entryRelativePath: "anim.html",
    viewport: { width: 320, height: 240, scale: 1 },
    sampleTimesMs: [0, 500],
    outputRoot: join(root, "out"),
    signal: AbortSignal.timeout(45_000),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.frames.length, 2);
  assert.notEqual(result.frames[0]!.contentHash, result.frames[1]!.contentHash);
});

test("opt-in real browser blocks external fetch, websocket, and file urls", async (t) => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== "1") {
    t.skip("set REPRISE_OPT_IN_BROWSER_RENDER=1 for live browser capture");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "reprise-render-block-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  let httpHits = 0;
  let wsHits = 0;
  let stunHits = 0;
  const external = createServer((_req, res) => {
    httpHits += 1;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("external");
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => external.close((error) => (error ? reject(error) : resolve()))));
  const address = external.address();
  assert.ok(address && typeof address !== "string");
  const wsProbe = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  wsProbe.on("upgrade", (_req, socket) => {
    wsHits += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => wsProbe.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => wsProbe.close((error) => (error ? reject(error) : resolve()))));
  const wsAddress = wsProbe.address();
  assert.ok(wsAddress && typeof wsAddress !== "string");
  const stunProbe = createSocket("udp4");
  stunProbe.on("message", () => {
    stunHits += 1;
  });
  await new Promise<void>((resolve, reject) => {
    stunProbe.once("error", reject);
    stunProbe.bind(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => stunProbe.close(() => resolve())));
  const stunPort = stunProbe.address().port;
  const fileUrl = pathToFileURL(join(root, "secret.txt")).href;
  const httpUrl = `http://127.0.0.1:${address.port}/x`;
  const wsUrl = `ws://127.0.0.1:${wsAddress.port}/probe`;
  const stunUrl = `stun:127.0.0.1:${stunPort}`;
  await writeFile(join(root, "secret.txt"), "nope", "utf8");
  await writeFile(join(root, "worker.js"), `try { new WebSocket(${JSON.stringify(wsUrl)}); } catch (e) {}`, "utf8");
  await writeFile(join(root, "sw.js"), `self.addEventListener('install', () => { fetch(${JSON.stringify(httpUrl)}).catch(()=>{}); });
fetch(${JSON.stringify(httpUrl)}).catch(()=>{});`, "utf8");
  await writeFile(join(root, "probe.html"), `<!doctype html><body>
<script>
fetch(${JSON.stringify(httpUrl)}).catch(()=>{});
fetch(${JSON.stringify(fileUrl)}).catch(()=>{});
try { new WebSocket(${JSON.stringify(wsUrl)}); } catch (e) {}
try {
  const blob = new Blob(['try { new WebSocket(${JSON.stringify(wsUrl)}); } catch (e) {}'], { type: 'text/javascript' });
  new Worker(URL.createObjectURL(blob));
} catch (e) {}
try { new Worker('worker.js'); } catch (e) {}
try { navigator.serviceWorker.register('sw.js'); } catch (e) {}
try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(stunUrl)} }] });
  pc.createDataChannel('x');
  pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(()=>{});
} catch (e) {}
try { new WebTransport(${JSON.stringify("https://127.0.0.1:" + stunPort + "/wt")}); } catch (e) {}
try { window.open(${JSON.stringify(httpUrl + "?via=open")}); } catch (e) {}
try {
  const a = document.createElement('a');
  a.href = ${JSON.stringify(httpUrl + "?via=blank")};
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
} catch (e) {}
</script>
ok
</body>`, "utf8");
  const result = await renderFrozenArtifact({
    bundleRoot: root,
    entryRelativePath: "probe.html",
    viewport: { width: 320, height: 240, scale: 1 },
    sampleTimesMs: [0, 400],
    outputRoot: join(root, "out"),
    signal: AbortSignal.timeout(45_000),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(httpHits, 0, `external http hits=${httpHits}`);
  assert.equal(wsHits, 0, `external ws hits=${wsHits}`);
  assert.equal(stunHits, 0, `stun/udp hits=${stunHits}`);
  assert.ok(result.diagnostics.some((item) => item.code === "network_blocked"));
  const gateText = result.diagnostics
    .filter((item) => item.code === "console_error")
    .map((item) => item.message)
    .join("\n");
  assert.match(gateText, /reprise-network-gate.*worker/i);
  assert.match(gateText, /reprise-network-gate.*serviceworker/i);
  assert.match(gateText, /reprise-network-gate.*webrtc/i);
  assert.match(gateText, /reprise-network-gate.*webtransport/i);
  assert.match(gateText, /reprise-network-gate.*window\.open/i);
  assert.match(gateText, /reprise-network-gate.*target_blank/i);
});
