import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFragment, serialize } from "parse5";
import { sha256 } from "../../src/core/identity.js";
import { createQuoteEvidenceTool, validateComparisonEvidenceQuotes } from "../../src/application/comparison-evidence-quotes.js";
import { createComparisonQuoteSourcePort, type ComparisonQuoteSourcePort } from "../../src/application/comparison-source.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { createComparisonRenderCatalogPort } from "../../src/application/comparison-render-catalog.js";
import type { ComparisonLinkRecord } from "../../src/core/schema.js";

function fixture(text: string, side: "baseline" | "candidate" | "derived" = "baseline") {
  let bytes = Buffer.from(text);
  const originalHash = sha256(bytes);
  const sources: ComparisonQuoteSourcePort = { resolveTextSource: async ref => ref === "ev-01" ? { bytes, sourceHash: originalHash, side } : undefined };
  const tool = createQuoteEvidenceTool({ sources });
  return {
    sources,
    mutate: (next: string) => { bytes = Buffer.from(next); },
    run: async (params: unknown = { sourceRef: "ev-01" }, signal = new AbortController().signal) =>
      JSON.parse((await tool.execute(params, signal)).content) as { status: string; html: string; scope: string; sourceHash: string },
  };
}

test("exact complete quotation preserves CRLF, leading LF, BOM, Unicode, entities and hostile markup", async () => {
  const f = fixture("\n\uFEFF中文\r\n<&> </code></pre><script>alert(1)</script>");
  const out = await f.run();
  assert.equal(out.status, "ok");
  assert.equal(out.scope, "full");
  assert.match(out.html, /历史 · 完整原文/);
  assert.doesNotMatch(out.html, /\r/);
  assert.doesNotMatch(out.html, /<script>/);
  assert.equal(await validateComparisonEvidenceQuotes(out.html, f.sources), undefined);
  assert.equal(await validateComparisonEvidenceQuotes(serialize(parseFragment(out.html)), f.sources), undefined);
  assert.equal(await validateComparisonEvidenceQuotes(`<!doctype html><html><body>${out.html}</body></html>`, f.sources), undefined);
});

test("exact excerpt cannot be relabelled as full or altered without invalidating source fidelity", async () => {
  const f = fixture("before\r\n中文\r\nafter", "candidate");
  const out = await f.run({ sourceRef: "ev-01", range: { startByte: 8, endByte: 14 } });
  assert.equal(out.status, "ok");
  assert.equal(out.scope, "excerpt");
  assert.match(out.html, /当前 · 节选/);
  assert.equal(await validateComparisonEvidenceQuotes(out.html, f.sources), undefined);
  for (const tampered of [
    out.html.replace("中文", "中误"),
    out.html.replace("当前 · 节选", "当前 · 完整原文"),
    out.html.replace('data-quote-scope="excerpt"', 'data-quote-scope="full"'),
    out.html.replace('data-start-byte="8"', 'data-start-byte="0"'),
    out.html.replace(out.sourceHash, "0".repeat(64)),
    out.html.replace('data-evidence-ref="ev-01"', 'data-evidence-ref="ev-02"'),
    out.html.replace("<pre>", '<pre hidden="">'),
    out.html.replace("中文", "中文<!-- deceptive extra content -->"),
  ]) assert.match((await validateComparisonEvidenceQuotes(tampered, f.sources)) ?? "", /Evidence quote/);
  f.mutate("before\r\n中误\r\nafter");
  assert.match((await validateComparisonEvidenceQuotes(out.html, f.sources)) ?? "", /source_changed/);
  assert.equal((await f.run()).status, "source_changed");
});

test("invalid, split UTF-8, binary, oversized and cancelled requests never yield a full quote", async () => {
  const f = fixture("中文");
  assert.equal((await f.run({ sourceRef: "ev-01", range: { startByte: 1, endByte: 6 } })).status, "not_text");
  for (const range of [{ startByte: 7, endByte: 8 }, { startByte: 3, endByte: 0 }]) {
    assert.equal((await f.run({ sourceRef: "ev-01", range })).status, "invalid_range");
  }
  for (const params of [{ sourceRef: "../ev-01" }, { sourceRef: "ev-01", path: "C:/private" }, { sourceRef: "ev-01", range: { startByte: -1, endByte: 2 } }]) {
    assert.equal((await f.run(params)).status, "invalid_request");
  }
  assert.equal((await f.run({ sourceRef: "ev-02" })).status, "unknown_source");
  assert.equal((await fixture("x\0y").run()).status, "not_text");
  assert.equal((await fixture("x".repeat(16385)).run()).status, "too_large");
  assert.equal((await fixture("&".repeat(4000)).run()).status, "too_large");
  assert.equal((await fixture("").run()).scope, "full");
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await f.run(undefined, cancelled.signal)).status, "cancelled");
  assert.equal(await validateComparisonEvidenceQuotes("<p>Legacy prose without a quotation component.</p>", f.sources), undefined);
  assert.equal(await validateComparisonEvidenceQuotes("<p>Legacy report without registered quote components.</p>"), undefined);
  assert.match((await validateComparisonEvidenceQuotes('<figure data-component="evidence-quote"></figure>')) ?? "", /without/);
  assert.match((await validateComparisonEvidenceQuotes('<figure data-component="evidence-quote"></figure>', f.sources)) ?? "", /invalid/);
  assert.match((await validateComparisonEvidenceQuotes('<template><figure data-component="evidence-quote"></figure></template>', f.sources)) ?? "", /invalid/);
  const binary: ComparisonQuoteSourcePort = { resolveTextSource: async () => ({ bytes: Buffer.from("png"), sourceHash: sha256("png"), side: "derived", mediaType: "image/png" }) };
  assert.equal((JSON.parse((await createQuoteEvidenceTool({ sources: binary }).execute({ sourceRef: "ev-01" }, new AbortController().signal)).content) as { status: string }).status, "not_text");
  const invalidUtf8: ComparisonQuoteSourcePort = { resolveTextSource: async () => ({ bytes: Buffer.from([0xff]), sourceHash: sha256(Buffer.from([0xff])), side: "host" }) };
  assert.equal((JSON.parse((await createQuoteEvidenceTool({ sources: invalidUtf8 }).execute({ sourceRef: "ev-01" }, new AbortController().signal)).content) as { status: string }).status, "not_text");
  assert.match((await fixture("derived", "derived").run()).html, /派生 · 完整原文/);
});

test("source resolver reads only registered mounted identities, rechecks bytes and respects text privacy", async t => {
  const root = await mkdtemp(join(tmpdir(), "reprise-quotes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const turns = join(root, "turns");
  const outside = join(root, "outside");
  await mkdir(turns); await mkdir(outside);
  await writeFile(join(turns, "visible.txt"), "original");
  await writeFile(join(outside, "secret.txt"), "outside");
  const links: ComparisonLinkRecord[] = [{ shortRef: "ev-01", side: "candidate", inspectPath: "turns/visible.txt", contentHash: sha256("original") }];
  const args = { evidence: () => links, attemptRoot: root, mounts: { turns }, allowModelText: true };
  const sources = createComparisonQuoteSourcePort(args);
  assert.equal(Buffer.from((await sources.resolveTextSource("ev-01"))?.bytes ?? []).toString(), "original");
  assert.equal(await sources.resolveTextSource("turns/visible.txt"), undefined);
  assert.equal(await sources.resolveTextSource("ev-02"), undefined);
  assert.equal(await createComparisonQuoteSourcePort({ ...args, allowModelText: false }).resolveTextSource("ev-01"), undefined);
  await writeFile(join(turns, "visible.txt"), "modified");
  assert.equal(await sources.resolveTextSource("ev-01"), undefined);
  for (const inspectPath of ["turns/../outside/secret.txt", "C:/secret.txt", "/turns/visible.txt", "outside/secret.txt"]) {
    links[0] = { shortRef: "ev-01", side: "candidate", inspectPath };
    assert.equal(await sources.resolveTextSource("ev-01"), undefined);
  }
  await symlink(outside, join(turns, "escape"), "junction");
  links[0] = { shortRef: "ev-01", side: "candidate", inspectPath: "turns/escape/secret.txt" };
  assert.equal(await sources.resolveTextSource("ev-01"), undefined);
  links[0] = { shortRef: "ev-01", side: "host", inspectPath: "turns/missing.txt" };
  assert.equal(await sources.resolveTextSource("ev-01"), undefined);
  links[0] = { shortRef: "ev-01", side: "host", inspectPath: "run/visible.txt" };
  assert.equal(await sources.resolveTextSource("ev-01"), undefined);
  const runSources = createComparisonQuoteSourcePort({ ...args, mounts: { run: turns } });
  assert.equal(Buffer.from((await runSources.resolveTextSource("ev-01"))?.bytes ?? []).toString(), "modified");
});

test("shared resolver does not expand render bundles to text projections, and render rejects replaced sealed bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const finals = join(root, "finals"); await mkdir(finals);
  await writeFile(join(finals, "page.svg"), "<svg/>");
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "quote-source-test", media: [], links: [
    { side: "baseline", inspectPath: "finals/page.svg", contentHash: sha256("<svg/>") },
    { side: "candidate", inspectPath: "turns/page.svg", contentHash: sha256("<svg/>") },
  ] });
  const mounts = { finals, candidate: finals, history: finals, evidence: finals, turns: finals };
  const render = createComparisonRenderCatalogPort({ catalog, attemptRoot: root, mounts });
  const refs = catalog.evidenceShortRefs();
  assert.ok(refs[0]); assert.ok(refs[1]);
  assert.equal((await render.resolveSource(refs[0]))?.contentHash, sha256("<svg/>"));
  assert.equal(await render.resolveSource(refs[1]), undefined);
  await writeFile(join(finals, "page.svg"), "<svg>replaced</svg>");
  assert.equal(await render.resolveSource(refs[0]), undefined);
});
