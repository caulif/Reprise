import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "parse5";
import { sha256 } from "../../src/core/identity.js";
import type { ComparisonLinkRecord } from "../../src/core/schema.js";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import { loadComparisonContentSnapshot } from "../../src/application/comparison-report-content.js";
import { materializeComparisonReportPreview } from "../../src/application/comparison-report-preview.js";
import { publishComparisonArtifacts, verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { sealOriginalLink } from "../../src/application/comparison-publication-assets.js";

type Node = { tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
function nodes(root: Node): Node[] { return [root, ...(root.childNodes ?? []).flatMap(nodes)]; }
function text(root: Node): string { return root.value ?? (root.childNodes ?? []).map(text).join(""); }

async function assertOpenable(html: string, root: string, expected: string): Promise<void> {
  const all = nodes(parse(html) as Node);
  const link = all.find((node) => node.tagName === "a" && text(node) === "Open original check");
  assert.ok(link, "the authored evidence link must remain visible");
  const href = link.attrs?.find((attr) => attr.name === "href")?.value;
  assert.ok(href, "registered evidence must receive a usable target");
  if (href.startsWith("#")) {
    const target = all.find((node) => node.attrs?.some((attr) => attr.name === "id" && attr.value === href.slice(1)));
    assert.ok(target, "inline evidence target must exist");
    assert.ok(text(target).includes(expected));
  } else {
    assert.equal(await readFile(join(root, href), "utf8"), expected);
  }
}

for (const derived of [true, false]) test(`${derived ? "derived" : "original"} evidence links open the sealed bytes in both preview and published reports`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-evidence-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const published = join(root, "published");
  const attempt = join(published, "comparison-attempts", "attempt");
  await mkdir(join(attempt, "work", "report"), { recursive: true });
  await mkdir(join(attempt, "evidence"));
  const expected = "The multiline input produced exactly one record.\n";
  const file = derived ? "check.txt" : "检查 结果.txt";
  await writeFile(join(attempt, "evidence", file), expected);
  await writeFile(join(attempt, "work", "report", "content.json"), JSON.stringify({
    schemaVersion: 1, headline: "The recorded row count differs", criticalLimitations: [], evidenceRefs: ["ev-01"],
  }));
  await writeFile(join(attempt, "work", "report", "body.html"), '<p>The row count is recorded in the check. <a data-evidence-ref="ev-01">Open original check</a></p>');
  const original: ComparisonLinkRecord = { side: derived ? "derived" : "candidate", shortRef: "ev-01", inspectPath: `evidence/${file}`,
    reportHref: `evidence/${file}`, contentHash: sha256(expected), mediaType: "text/plain",
    ...(derived ? { origin: "derived_analysis" as const } : {}) };
  const evidence = [derived ? original : await sealOriginalLink(attempt, join(attempt, "evidence", file), original)];
  const facts: ComparisonReportFacts = {
    run: { runId: "fixture", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
    models: { baseline: "A", candidate: "B" }, activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
    delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unavailable" },
    replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
  };
  const preview = await materializeComparisonReportPreview({ attemptRoot: attempt, experimentRoot: published, hostTask: "Compare row counts", facts,
    media: [], evidence, catalogRevision: 1 });
  await assertOpenable(preview.html, preview.outputRoot, expected);
  if (!derived) await writeFile(join(attempt, "evidence", file), "Changed after preview.\n");
  const checked = await verifyAndRenderComparisonReport({ content: await loadComparisonContentSnapshot(attempt),
    hostTask: "Compare row counts", facts, attemptRoot: attempt, media: [], evidence });
  assert.ok(!("failureClass" in checked));
  const publication = { attemptRoot: attempt, experimentRoot: published, html: checked.html, model: checked.model, media: [], evidence };
  await publishComparisonArtifacts(publication);
  await assertOpenable(await readFile(join(published, "report.html"), "utf8"), published, expected);
});
