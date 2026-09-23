import test from "node:test";
import assert from "node:assert/strict";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import { verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { renderComparisonReportShell } from "../../src/application/comparison-report-shell.js";

const facts: ComparisonReportFacts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { baseline: "historical-model", candidate: "candidate-model" },
  activity: {},
  limits: { triggered: [] },
  runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unavailable" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
  metrics: { baseline: { elapsedMs: 5000 }, candidate: { elapsedMs: 7000 } },
};

function draft(comparison = "<p>候选交付了文件。</p>"): string {
  return renderComparisonReportShell({
    task: "Host 原任务文案。",
    facts,
    metrics: facts.metrics ?? {},
    slots: { category: "实测结果", headline: "候选交付了文件。", comparison },
  });
}

async function verify(html: string, extra: Partial<Parameters<typeof verifyAndRenderComparisonReport>[0]> = {}) {
  return verifyAndRenderComparisonReport({
    html,
    facts,
    hostTask: "Host 原任务文案。",
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
    ...extra,
  });
}

test("Host rebuilds changed metrics, task, title, CSS and evidence from trusted facts", async () => {
  const changed = draft()
    .replace("Host 原任务文案。", "Agent 篡改任务。")
    .replace('data-id="host-metrics"', 'data-id="host-metrics" data-tampered="yes"')
    .replace("7 s", "999 s")
    .replace("<title>", "<title>Agent 标题 ")
    .replace("--ink:", "--tampered:")
    .replace('data-id="host-evidence"', 'data-id="host-evidence" data-tampered="yes"');
  const result = await verify(changed);
  assert.equal("html" in result, true);
  if ("html" in result) {
    assert.match(result.html, /Host 原任务文案。/);
    assert.match(result.html, /候选交付了文件。/);
    assert.doesNotMatch(result.html, /Agent 篡改任务|data-tampered|Agent 标题|--tampered|999 s/);
    assert.match(result.html, /data-host-zone="evidence"/);
  }
});

test("missing, duplicate, nested and malformed Agent markers fail extraction", async () => {
  const base = draft();
  const cases = [
    base.replace('data-agent-slot="task"', 'data-missing-slot="task"'),
    base.replace("</body>", '<section data-agent-zone="comparison">duplicate</section></body>'),
    base.replace("候选交付了文件。</p>", '<span data-agent-zone="details">nested</span>候选交付了文件。</p>'),
    base.replace("候选交付了文件。</p>", '<span data-host-zone="metrics">forged</span>候选交付了文件。</p>'),
    base.replace('<section class="slot" data-agent-zone="comparison"', '<section class="slot" data-agent-zone="comparison" data-agent-slot="headline"'),
  ];
  for (const html of cases) {
    const result = await verify(html);
    assert.equal("html" in result, false);
    if (!("html" in result)) assert.equal(result.code, "report_incomplete");
  }
});

test("rebuild still rejects external resources and unregistered evidence or media", async () => {
  const cases = [
    [draft('<script src="https://evil.example/code.js"></script><p>差异。</p>'), "report_incomplete"],
    [draft('<p style="background:url(https://evil.example/x.png)">差异。</p>'), "report_incomplete"],
    [draft('<a data-evidence-ref="ev-99">没有登记</a>'), "evidence_unresolved"],
    [draft('<img data-media-ref="media-99" alt="没有登记">'), "media_unavailable"],
    [draft('<span data-claim="visual">我看到了红色</span>'), "media_unavailable"],
  ] as const;
  for (const [html, code] of cases) {
    const result = await verify(html, { deliveredImageContentHashes: new Set() });
    assert.equal("html" in result, false);
    if (!("html" in result)) assert.equal(result.code, code);
  }
});

test("active Agent HTML cannot reach the published report through parser normalization", async () => {
  const payloads = [
    '<ScRiPt>alert(1)</ScRiPt><p>差异。</p>',
    '<img src=media/ok.png OnErRoR=alert(1) alt=preview>',
    '<a href=&#x6a;avascript:alert(1)>打开</a>',
    '<a href="java&#10;script:alert(1)">打开</a>',
    '<a href=DaTa:text/html,attack>打开</a>',
    '<svg OnLoAd=alert(1)><circle r=2></circle></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<p style="background:url(//evil.example/x.png)">差异。</p>',
    '<template><script>alert(1)</script></template><p>差异。</p>',
  ];
  for (const payload of payloads) {
    const result = await verify(draft(payload));
    assert.equal("html" in result, false, payload);
    if (!("html" in result)) assert.equal(result.code, "report_incomplete", payload);
  }
  const localAnchor = await verify(draft('<p>差异。<a href="#proof">查看依据</a></p>'));
  assert.equal("html" in localAnchor, true);
});

test("Agent inline styles cannot cover Host facts in a published report", async () => {
  const payloads = [
    '<div style="position:fixed;inset:0;z-index:2147483647;background:white">FAKE HOST FACTS</div>',
    '<div StYlE=position:fixed>FAKE HOST FACTS</div>',
    '<p style="color:red">Styled conclusion</p>',
  ];
  for (const payload of payloads) {
    const result = await verify(draft(payload));
    assert.equal("html" in result, false, payload);
    if (!("html" in result)) {
      assert.equal(result.code, "report_incomplete", payload);
      assert.match(result.message, /style/, payload);
    }
    const legacy = await verifyAndRenderComparisonReport({
      html: draft(payload), facts,
      result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
      attemptRoot: ".", media: [],
    });
    assert.equal("html" in legacy, false, payload);
    if (!("html" in legacy)) assert.equal(legacy.code, "report_incomplete", payload);
  }
});

test("native overlays cannot cover Host facts in either publication path", async () => {
  const payloads = [
    '<dialog open>FAKE HOST FACTS</dialog>',
    '<DIALOG OPEN>FAKE HOST FACTS</DIALOG>',
    '<div popover id="fake">FAKE HOST FACTS</div><button popovertarget="fake">Open</button>',
  ];
  for (const payload of payloads) {
    const html = draft(payload);
    for (const input of [
      { hostTask: "Host 原任务文案。" },
      {},
    ]) {
      const result = await verifyAndRenderComparisonReport({
        html, facts,
        result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
        attemptRoot: ".", media: [], ...input,
      });
      assert.equal("html" in result, false, payload);
      if (!("html" in result)) {
        assert.equal(result.code, "report_incomplete", payload);
        assert.match(result.message, /dialog|popover/i, payload);
      }
    }
  }
});

test("markers hidden in template content are still counted", async () => {
  const duplicate = draft().replace(
    "</body>",
    '<template><section data-agent-zone="comparison">hidden duplicate</section></template></body>',
  );
  const result = await verify(duplicate);
  assert.equal("html" in result, false);
  if (!("html" in result)) assert.equal(result.code, "report_incomplete");
});

test("report title and side labels show requested and resolved models without changing raw ID", () => {
  const divergent: ComparisonReportFacts = {
    ...facts,
    models: {
      ...facts.models,
      candidate: "deepseek/deepseek-v4.1-flash",
      candidateRequested: "sonnet",
      candidateResolved: "deepseek/deepseek-v4.1-flash",
    },
  };
  const html = renderComparisonReportShell({ task: "Host 原任务文案。", facts: divergent, metrics: {}, locale: "zh" });
  assert.match(html, /请求 sonnet → 解析 deepseek\/deepseek-v4\.1-flash/);
  assert.equal(divergent.models.candidate, "deepseek/deepseek-v4.1-flash");
  const same = renderComparisonReportShell({
    task: "Task.",
    facts: { ...facts, models: { ...facts.models, candidateRequested: "sonnet", candidateResolved: "sonnet" } },
    metrics: {},
    locale: "en",
  });
  assert.doesNotMatch(same, /requested sonnet → resolved sonnet/);
  const unknown = renderComparisonReportShell({
    task: "Task.",
    facts: { ...facts, models: { ...facts.models, candidateRequested: "sonnet" } },
    metrics: {},
    locale: "en",
  });
  assert.match(unknown, /requested sonnet · resolution unconfirmed/);
});
