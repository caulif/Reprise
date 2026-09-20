import test from "node:test";
import assert from "node:assert/strict";
import { ComparisonVisualMediaError } from "../../src/application/comparison-openable-media.js";
import { mapBriefingErrorToComparisonResult } from "../../src/application/experiment-report.js";

test("AbortError from briefing maps to cancelled not publication_failed", () => {
  const cancelled = mapBriefingErrorToComparisonResult(new DOMException("The operation was aborted.", "AbortError"));
  assert.equal(cancelled.status, "cancelled");

  const named = mapBriefingErrorToComparisonResult(Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal(named.status, "cancelled");

  const media = mapBriefingErrorToComparisonResult(new ComparisonVisualMediaError("no headless browser"));
  assert.equal(media.status, "failed");
  assert.equal(media.status === "failed" ? media.failure.code : undefined, "media_unavailable");

  const other = mapBriefingErrorToComparisonResult(new Error("disk full"));
  assert.equal(other.status, "failed");
  assert.equal(other.status === "failed" ? other.failure.code : undefined, "publication_failed");
});
