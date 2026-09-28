import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeComparisonReportPreview } from "../../src/application/comparison-report-preview.js";
import { prepareComparisonArtifacts } from "../../src/application/comparison-publication.js";
import { augmentComparisonOpenableMedia } from "../../src/application/comparison-openable-media.js";
import { sha256 } from "../../src/core/identity.js";

test("preview copies referenced derived evidence and tracks its bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-derived-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "comparison-attempts", "attempt-1");
  const original = Buffer.from("<!doctype html><html><body>original</body></html>");
  const contentHash = sha256(original);
  const href = `evidence/derived/${contentHash.slice(0, 16)}.html`;
  const source = join(attemptRoot, ...href.split("/"));
  await mkdir(join(attemptRoot, "evidence", "derived"), { recursive: true });
  await writeFile(source, original);
  const evidence = [{ side: "derived" as const, inspectPath: href, reportHref: href,
    origin: "derived_analysis" as const, contentHash }];
  const input = { attemptRoot, draftHtml: `<a href="${href}">analysis</a>`, media: [], evidence, catalogRevision: 1 };
  const preview = await materializeComparisonReportPreview(input);
  assert.deepEqual(await readFile(join(preview.outputRoot, ...href.split("/"))), original);
  await writeFile(source, "changed");
  await assert.rejects(materializeComparisonReportPreview(input), /hash mismatch/);
});

test("historical final links resolve in draft, bounded preview, and published report", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-preview-finals-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  await mkdir(join(attemptRoot, "finals", "assets"), { recursive: true });
  await writeFile(join(attemptRoot, "finals", "index.html"), '<link rel="stylesheet" href="assets/site.css"><h1>Historical final</h1><a href="missing-next.html">Next</a>');
  await writeFile(join(attemptRoot, "finals", "assets", "site.css"), 'h1 { color: green; background: url("icon.png"); }');
  await writeFile(join(attemptRoot, "finals", "assets", "icon.png"), "image bytes");
  await writeFile(join(attemptRoot, "finals", "unrelated.txt"), "unrelated");
  const draft = '<section data-host-zone="evidence"><a href="finals/index.html">Final</a></section><section data-agent-zone="comparison"><a data-evidence-ref="ev-01">Inspect</a></section>';
  await writeFile(join(attemptRoot, "report.html"), draft);
  const evidence = [{ side: "baseline" as const, inspectPath: "finals/index.html", reportHref: "finals/index.html", origin: "historical_artifact" as const, shortRef: "ev-01" }];
  assert.match(draft, /href="finals\/index\.html"/);

  const preview = await materializeComparisonReportPreview({ attemptRoot, media: [], evidence, catalogRevision: 1 });
  assert.match(preview.html, /href="finals\/index\.html"/);
  assert.match(await readFile(join(preview.outputRoot, "finals", "index.html"), "utf8"), /Historical final/);
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "site.css"), "utf8"), 'h1 { color: green; background: url("icon.png"); }');
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "icon.png"), "utf8"), "image bytes");
  await assert.rejects(readFile(join(preview.outputRoot, "finals", "unrelated.txt")));
  await assert.rejects(readFile(join(preview.outputRoot, "finals", "missing-next.html")));
  await writeFile(join(attemptRoot, "finals", "unrelated.txt"), "changed unrelated");
  const unchanged = await materializeComparisonReportPreview({ attemptRoot, media: [], evidence, catalogRevision: 1 });
  assert.equal(unchanged.dependencyDigest, preview.dependencyDigest);
  await writeFile(join(attemptRoot, "finals", "assets", "site.css"), "h1 { color: blue; }");
  const refreshed = await materializeComparisonReportPreview({ attemptRoot, media: [], evidence, catalogRevision: 1 });
  assert.notEqual(refreshed.dependencyDigest, preview.dependencyDigest);
  assert.equal(await readFile(join(refreshed.outputRoot, "finals", "assets", "site.css"), "utf8"), "h1 { color: blue; }");

  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot, html: preview.html, media: [], evidence });
  assert.match(published.html, /href="comparison-attempts\/attempt-1\/published-finals\/[a-f0-9]{64}\/finals\/index\.html"/);
  assert.match(await readFile(join(experimentRoot, "comparison-attempts", "attempt-1", "finals", "index.html"), "utf8"), /Historical final/);
});

test("a historical final with a URL fragment character resolves through catalog, preview, and publication", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-preview-hash-final-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  await mkdir(join(attemptRoot, "finals"), { recursive: true });
  const source = join(attemptRoot, "finals", "a#b.html");
  await writeFile(source, "<h1>Hash final</h1>");
  const catalog = await augmentComparisonOpenableMedia({
    attemptRoot, workspaceRoot: experimentRoot, links: [],
    baselineSources: [{ inspectPath: "finals/a#b.html", absolutePath: source }],
    candidateSources: [],
  });
  const link = catalog.links.find((item) => item.inspectPath === "finals/a#b.html");
  assert.ok(link);
  assert.equal(link?.reportHref, "finals/a%23b.html");
  const draftHtml = `<a href="${link.reportHref}">Final</a>`;
  const preview = await materializeComparisonReportPreview({ attemptRoot, draftHtml, media: [], evidence: catalog.links, catalogRevision: 1 });
  assert.equal(await readFile(join(preview.outputRoot, "finals", "a#b.html"), "utf8"), "<h1>Hash final</h1>");
  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot, html: preview.html, evidence: catalog.links });
  assert.match(published.html, /href="comparison-attempts\/attempt-1\/published-finals\/[a-f0-9]{64}\/finals\/a%23b\.html"/);
});

test("historical preview rewrites root resources and includes module imports without splitting data srcset URLs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-bundle-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "comparison-attempts", "attempt");
  await mkdir(join(attemptRoot, "finals", "pages"), { recursive: true });
  await mkdir(join(attemptRoot, "finals", "assets"), { recursive: true });
  await writeFile(join(attemptRoot, "finals", "pages", "index.html"),
    '<link rel="stylesheet" href="/assets/site.css"><script type="module" src="/assets/app.js"></script>'
    + '<script type="module">import "/assets/inline.js";</script>'
    + '<img srcset="data:image/png;base64,AAAA 1x, /assets/large.png 2x"><a href="/elsewhere.html">Next</a>'
    + '<template><img src="/missing-template.png"></template>');
  await writeFile(join(attemptRoot, "finals", "assets", "site.css"),
    '@import "/assets/theme.css"; .icon { background: url(/assets/icon.png); }'
    + ' /* url("/assets/missing-comment.png") */ .label::before { content: "url(/assets/missing-string.png)"; }');
  await writeFile(join(attemptRoot, "finals", "assets", "theme.css"), "body { color: green; }");
  await writeFile(join(attemptRoot, "finals", "assets", "icon.png"), "icon");
  await writeFile(join(attemptRoot, "finals", "assets", "large.png"), "large");
  await writeFile(join(attemptRoot, "finals", "assets", "app.js"),
    'import "./view.js"; import "/assets/shared.js";');
  await writeFile(join(attemptRoot, "finals", "assets", "view.js"), "export const view = true;");
  await writeFile(join(attemptRoot, "finals", "assets", "shared.js"), "export const shared = true;");
  await writeFile(join(attemptRoot, "finals", "assets", "inline.js"), "export const inline = true;");
  const evidence = [{ side: "baseline" as const, inspectPath: "finals/pages/index.html",
    reportHref: "finals/pages/index.html", origin: "historical_artifact" as const }];
  const input = { attemptRoot, draftHtml: '<a href="finals/pages/index.html">Final</a>', media: [], evidence, catalogRevision: 1 };
  const preview = await materializeComparisonReportPreview(input);
  const page = await readFile(join(preview.outputRoot, "finals", "pages", "index.html"), "utf8");
  assert.match(page, /href="\.\.\/assets\/site\.css"/);
  assert.match(page, /src="\.\.\/assets\/app\.js"/);
  assert.match(page, /import "\.\.\/assets\/inline\.js"/);
  assert.match(page, /data:image\/png;base64,AAAA 1x, \.\.\/assets\/large\.png 2x/);
  assert.match(page, /href="\/elsewhere\.html"/);
  assert.match(await readFile(join(preview.outputRoot, "finals", "assets", "site.css"), "utf8"),
    /@import "\.\/theme\.css";.*url\(\.\/icon\.png\)/);
  await assert.rejects(readFile(join(preview.outputRoot, "finals", "assets", "missing-comment.png")));
  await assert.rejects(readFile(join(preview.outputRoot, "finals", "assets", "missing-string.png")));
  assert.match(await readFile(join(preview.outputRoot, "finals", "assets", "app.js"), "utf8"),
    /import "\.\/view\.js"; import "\.\/shared\.js"/);
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "view.js"), "utf8"), "export const view = true;");
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "shared.js"), "utf8"), "export const shared = true;");
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "inline.js"), "utf8"), "export const inline = true;");
  await assert.rejects(readFile(join(preview.outputRoot, "finals", "elsewhere.html")));
  await writeFile(join(attemptRoot, "finals", "assets", "shared.js"), "export const shared = false;");
  const refreshed = await materializeComparisonReportPreview(input);
  assert.notEqual(refreshed.dependencyDigest, preview.dependencyDigest);

  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot: root, html: preview.html, evidence });
  const publishedHref = published.html.match(/href="([^"]+\/finals\/pages\/index\.html)"/)?.[1];
  assert.ok(publishedHref);
  const publishedPage = await readFile(join(root, ...publishedHref.split("/")), "utf8");
  assert.match(publishedPage, /href="\.\.\/assets\/site\.css"/);
  assert.match(publishedPage, /src="\.\.\/assets\/app\.js"/);
  assert.match(publishedPage, /import "\.\.\/assets\/inline\.js"/);
  assert.equal(await readFile(join(root, ...publishedHref.split("/").slice(0, -2), "assets", "inline.js"), "utf8"),
    "export const inline = true;");
});

test("escaped historical final hrefs remain reachable in preview and publication", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-preview-escaped-final-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  await mkdir(join(attemptRoot, "finals"), { recursive: true });
  await writeFile(join(attemptRoot, "finals", "a&b.html"), "<h1>Historical final</h1>");
  const draftHtml = '<a href="finals/a&amp;b.html">Final</a>';
  const evidence = [{ side: "baseline" as const, inspectPath: "finals/a&b.html", reportHref: "finals/a&b.html", origin: "historical_artifact" as const }];

  const preview = await materializeComparisonReportPreview({ attemptRoot, draftHtml, media: [], evidence, catalogRevision: 1 });
  assert.equal(await readFile(join(preview.outputRoot, "finals", "a&b.html"), "utf8"), "<h1>Historical final</h1>");
  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot, html: preview.html, evidence });
  assert.match(published.html, /href="comparison-attempts\/attempt-1\/published-finals\/[a-f0-9]{64}\/finals\/a&amp;b\.html"/);
});

test("historical HTML base href keeps resources and navigation inside the preview and published bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-base-href-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "comparison-attempts", "attempt-1");
  await mkdir(join(attemptRoot, "finals", "pages"), { recursive: true });
  await mkdir(join(attemptRoot, "finals", "assets"), { recursive: true });
  const original = '<base href="/"><link rel="stylesheet" href="assets/site.css">'
    + '<img src="assets/logo.png"><script type="module">import "./assets/app.js";</script>'
    + '<a href="next.html">Next</a>';
  await writeFile(join(attemptRoot, "finals", "pages", "index.html"), original);
  await writeFile(join(attemptRoot, "finals", "assets", "site.css"), "body { color: green; }");
  await writeFile(join(attemptRoot, "finals", "assets", "logo.png"), "logo");
  await writeFile(join(attemptRoot, "finals", "assets", "app.js"), "export const ready = true;");
  const evidence = [{ side: "baseline" as const, inspectPath: "finals/pages/index.html",
    reportHref: "finals/pages/index.html", origin: "historical_artifact" as const }];
  const preview = await materializeComparisonReportPreview({ attemptRoot,
    draftHtml: '<a href="finals/pages/index.html">Final</a>', media: [], evidence, catalogRevision: 1 });
  const previewPage = await readFile(join(preview.outputRoot, "finals", "pages", "index.html"), "utf8");
  assert.match(previewPage, /<base href="\.\.\/">/);
  assert.match(previewPage, /href="assets\/site\.css"/);
  assert.match(previewPage, /href="next\.html"/);
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "logo.png"), "utf8"), "logo");
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "app.js"), "utf8"), "export const ready = true;");
  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot: root, html: preview.html, evidence });
  const publishedHref = published.html.match(/href="([^"]+\/finals\/pages\/index\.html)"/)?.[1];
  assert.ok(publishedHref);
  const publishedRoot = join(root, ...publishedHref.split("/").slice(0, -2));
  assert.match(await readFile(join(root, ...publishedHref.split("/")), "utf8"), /<base href="\.\.\/">/);
  assert.equal(await readFile(join(publishedRoot, "assets", "site.css"), "utf8"), "body { color: green; }");
  assert.equal(await readFile(join(publishedRoot, "assets", "app.js"), "utf8"), "export const ready = true;");
  assert.equal(await readFile(join(attemptRoot, "finals", "pages", "index.html"), "utf8"), original);
});

test("historical SVG and XHTML finals retain linked resources in preview and publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-xml-finals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "comparison-attempts", "attempt-1");
  await mkdir(join(attemptRoot, "finals", "assets"), { recursive: true });
  await writeFile(join(attemptRoot, "finals", "vector.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="/assets/logo.png"/></svg>');
  await writeFile(join(attemptRoot, "finals", "page.xhtml"),
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="/assets/site.css"/></head><body>Final</body></html>');
  await writeFile(join(attemptRoot, "finals", "assets", "logo.png"), "logo");
  await writeFile(join(attemptRoot, "finals", "assets", "site.css"), "body { color: green; }");
  const evidence = ["vector.svg", "page.xhtml"].map((name) => ({
    side: "baseline" as const, inspectPath: `finals/${name}`, reportHref: `finals/${name}`,
    origin: "historical_artifact" as const,
  }));
  const preview = await materializeComparisonReportPreview({ attemptRoot,
    draftHtml: '<a href="finals/vector.svg">SVG</a><a href="finals/page.xhtml">XHTML</a>',
    media: [], evidence, catalogRevision: 1 });
  assert.match(await readFile(join(preview.outputRoot, "finals", "vector.svg"), "utf8"), /xlink:href="\.\/assets\/logo\.png"/);
  assert.match(await readFile(join(preview.outputRoot, "finals", "page.xhtml"), "utf8"), /href="\.\/assets\/site\.css"/);
  assert.equal(await readFile(join(preview.outputRoot, "finals", "assets", "logo.png"), "utf8"), "logo");
  const published = await prepareComparisonArtifacts({ attemptRoot, experimentRoot: root, html: preview.html, evidence });
  const publishedRoot = published.html.match(/comparison-attempts\/attempt-1\/published-finals\/[a-f0-9]{64}/)?.[0];
  assert.ok(publishedRoot);
  assert.match(await readFile(join(root, publishedRoot, "finals", "vector.svg"), "utf8"), /xlink:href="\.\/assets\/logo\.png"/);
  assert.equal(await readFile(join(root, publishedRoot, "finals", "assets", "site.css"), "utf8"), "body { color: green; }");
});

test("preview rejects a finals directory link outside the attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-finals-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "attempt");
  const outside = join(root, "outside");
  await mkdir(attemptRoot);
  await mkdir(outside);
  await writeFile(join(outside, "index.html"), "<h1>Outside</h1>");
  await writeFile(join(outside, "private.txt"), "not preview evidence");
  await symlink(outside, join(attemptRoot, "finals"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(materializeComparisonReportPreview({
    attemptRoot,
    draftHtml: '<a href="finals/index.html">Final</a>',
    media: [],
    evidence: [{ side: "baseline", inspectPath: "finals/index.html", reportHref: "finals/index.html", origin: "historical_artifact" }],
    catalogRevision: 1,
  }), /finals escape attempt root/);
  await assert.rejects(readdir(join(attemptRoot, "review", "preview")));
});
