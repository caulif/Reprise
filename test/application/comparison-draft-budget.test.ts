import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ComparisonDraft } from "../../src/application/comparison-draft.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { ComparisonDraftSubmissionSchema } from "../../src/core/schema.js";
import { sha256 } from "../../src/core/identity.js";
import { comparisonMainTextCharacters, comparisonVisibleMainText } from "../../src/application/comparison-report-text.js";

const facts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { candidate: "candidate", baseline: "baseline" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "available" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};
const base = { status: "completed" as const, category: "Result", headline: "判", comparisonHtml: "<p>不同</p>" };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "reprise-draft-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs", facts, locale: "en", catalog, deliveredImages: new Set() });
  return { root, catalog, draft, tool: draft.tool(), signal: new AbortController().signal };
}

test("live tool requires decision shape while legacy direct schema remains compatible", async t => {
  const f = await fixture(t);
  assert.equal(Value.Check(ComparisonDraftSubmissionSchema, base), true);
  assert.equal(Value.Check(f.tool.parameters, base), false);
  assert.match((await f.tool.execute(base, f.signal)).content, /invalid_submission/);
  assert.match(await f.draft.submit({ ...base, comparisonHtml: `<p>${"字".repeat(700)}</p>` }), /status=accepted/);
  const inspected = JSON.parse((await f.draft.inspectTool().execute({}, f.signal)).content) as Record<string, unknown>;
  assert.equal(inspected.decisionShape, "unknown");
  assert.equal(inspected.decisionShapeValidation, "model_declaration_only");
});

test("single and multiple declarations enforce exact visible character budgets with reverse cases", async t => {
  const f = await fixture(t);
  for (const [decisionShape, maximum] of [["single_difference", 250], ["multiple_differences", 600]] as const) {
    const submission = { ...base, decisionShape, comparisonHtml: `<p>${"字".repeat(maximum - 2)}</p>`, detailsHtml: '<p>Supporting method.</p>' };
    const accepted = (await f.tool.execute(submission, f.signal)).content;
    assert.match(accepted, /status=accepted/);
    assert.match(accepted, new RegExp(`mainTextCharacters=${maximum}(?:\\n|$)`));
    assert.match(accepted, new RegExp(`mainTextMaximum=${maximum}`));
    const inspected = JSON.parse((await f.draft.inspectTool().execute({}, f.signal)).content) as Record<string, unknown>;
    assert.equal(inspected.decisionShape, decisionShape);
    assert.equal(inspected.mainTextCharacters, maximum);
    const rejected = (await f.tool.execute({ ...submission, comparisonHtml: `<p>${"字".repeat(maximum - 1)}</p>` }, f.signal)).content;
    assert.match(rejected, /code=draft_too_long/);
    assert.match(rejected, new RegExp(`maximum=${maximum}`));
    assert.match(rejected, /Do not relabel one difference as multiple/);
  }
});

test("over-budget revision preserves accepted bytes and preview; changing declaration requires a new preview", async t => {
  const f = await fixture(t);
  await f.tool.execute({ ...base, decisionShape: "single_difference" }, f.signal);
  const html = await readFile(join(f.root, "report.html"), "utf8");
  const digest = sha256(html);
  const preview = { htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest, catalogRevision: f.catalog.snapshot().revision, outputRoot: f.root };
  f.draft.recordPreview(preview);
  assert.ok(await f.draft.completedResult());
  assert.match((await f.tool.execute({ ...base, decisionShape: "single_difference", comparisonHtml: `<p>${"字".repeat(249)}</p>` }, f.signal)).content, /draft_too_long/);
  assert.equal(await readFile(join(f.root, "report.html"), "utf8"), html);
  assert.ok(await f.draft.completedResult());
  const inspected = JSON.parse((await f.draft.inspectTool().execute({}, f.signal)).content) as Record<string, unknown>;
  assert.equal(inspected.draftDigest, digest);
  assert.equal(inspected.decisionShape, "single_difference");
  await f.tool.execute({ ...base, decisionShape: "multiple_differences" }, f.signal);
  assert.equal(await f.draft.completedResult(), undefined);
});

test("details budgets count folded explanations and reject without replacing inspected accepted bindings", async t => {
  const f = await fixture(t);
  for (const [decisionShape, maximum] of [["single_difference", 400], ["multiple_differences", 1000]] as const) {
    const submission = { ...base, decisionShape, detailsHtml: `<p hidden>${"字".repeat(maximum)}</p>` };
    assert.match(await f.draft.submit(submission), /status=accepted/);
    f.draft.beginReview();
    const inspectTool = f.draft.inspectTool();
    await inspectTool.onCompleted!(await inspectTool.execute({}, f.signal));
    const html = await readFile(join(f.root, "report.html"), "utf8");
    const digest = sha256(html);
    f.draft.recordPreview({ htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest,
      dependencyDigest: digest, catalogRevision: f.catalog.snapshot().revision, outputRoot: f.root });
    assert.ok(await f.draft.completedResult());
    const rejected = await f.draft.submit({ ...submission,
      detailsHtml: `<details><summary>方法</summary><details><summary>范围</summary>${"字".repeat(maximum)}</details></details>` });
    assert.match(rejected, /code=draft_details_too_long/);
    assert.match(rejected, new RegExp(`maximum=${maximum}`));
    assert.equal(await readFile(join(f.root, "report.html"), "utf8"), html);
    assert.ok(await f.draft.completedResult());
  }
});

test("length rejection provides the same Unicode-visible text as the DOM counter without changing the accepted preview", async t => {
  const f = await fixture(t);
  await f.tool.execute({ ...base, decisionShape: "single_difference" }, f.signal);
  const html = await readFile(join(f.root, "report.html"), "utf8");
  const digest = sha256(html);
  f.draft.recordPreview({ htmlPath: "preview.html", html, draftDigest: digest, preparedDigest: digest, dependencyDigest: digest, catalogRevision: f.catalog.snapshot().revision, outputRoot: f.root });
  const rejected = (await f.tool.execute({ ...base, decisionShape: "single_difference", comparisonHtml: `<p>${"🛞字".repeat(125)}</p><details><summary>方法</summary>折叠正文不计数</details>` }, f.signal)).content;
  const line = rejected.split("\n").find(line => line.startsWith("visibleMainText="));
  assert.ok(line);
  const text = JSON.parse(line.slice("visibleMainText=".length)) as string;
  const count = Number(rejected.match(/mainTextCharacters=(\d+)/)?.[1]);
  assert.equal([...text].length, count);
  assert.ok(text.length > count);
  assert.ok(text.startsWith("判 "));
  assert.ok(text.endsWith(" 方法"));
  assert.ok(!text.includes("折叠正文不计数"));
  assert.equal(await readFile(join(f.root, "report.html"), "utf8"), html);
  assert.ok(await f.draft.completedResult());
  const fixtureHtml = '<p data-agent-slot="headline">判 🛞</p><section data-agent-zone="comparison"><p>证据</p><template>模板不计</template><script>脚本不计</script><style>样式不计</style><details><summary>方法</summary>折叠不计</details><details open><summary>展开</summary>计入</details></section>';
  const visible = comparisonVisibleMainText(fixtureHtml);
  assert.equal(comparisonMainTextCharacters(fixtureHtml), [...visible].length);
  assert.equal(visible, "判 🛞 证据 方法 展开 计入");
});
