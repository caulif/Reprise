import test from "node:test";
import assert from "node:assert/strict";
import type { ComparisonMediaRecord } from "../../src/core/schema.js";
import { renderVisualEvidenceSeed, visualEvidenceUnavailableReason } from "../../src/application/comparison-visual-evidence.js";

function mediaRecord(side: ComparisonMediaRecord["side"], available: boolean): ComparisonMediaRecord {
  return {
    ref: `media:${side}`,
    side,
    inspectPath: `${side}/preview.png`,
    reportHref: `media/${side}.png`,
    mediaType: "image/png",
    available,
  };
}

test("visualEvidenceUnavailableReason distinguishes empty media from registered-but-unavailable", () => {
  assert.equal(visualEvidenceUnavailableReason([], "zh"), "本次对照未登记可用的预览图。");
  assert.equal(
    visualEvidenceUnavailableReason([mediaRecord("baseline", false), mediaRecord("candidate", false)], "zh"),
    "预览图已登记，但源文件不可用。",
  );
  assert.doesNotMatch(
    visualEvidenceUnavailableReason([mediaRecord("baseline", false), mediaRecord("candidate", false)], "zh") ?? "",
    /未能固化/,
  );
});

test("visualEvidenceUnavailableReason treats single-side unavailable registration as registered-but-unavailable", () => {
  assert.equal(
    visualEvidenceUnavailableReason([mediaRecord("baseline", false)], "zh"),
    "预览图已登记，但源文件不可用。",
  );
  assert.equal(
    visualEvidenceUnavailableReason([mediaRecord("candidate", false)], "zh"),
    "预览图已登记，但源文件不可用。",
  );
});

test("visualEvidenceUnavailableReason reserves sources-missing for non-side media entries", () => {
  assert.equal(
    visualEvidenceUnavailableReason([mediaRecord("host", false)], "zh"),
    "引用了预览图，但未能固化到对照媒体索引。",
  );
});

test("renderVisualEvidenceSeed surfaces registered-but-unavailable reason", () => {
  const html = renderVisualEvidenceSeed(
    [mediaRecord("baseline", false), mediaRecord("candidate", false)],
    "zh",
  );
  assert.match(html, /data-host="visual-unavailable"/);
  assert.match(html, /预览图已登记，但源文件不可用。/);
});
