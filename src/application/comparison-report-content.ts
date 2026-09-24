import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../core/identity.js";
import { ComparisonReportContentSchema, type ComparisonReportContent } from "../core/schema.js";
import { isMissing } from "./experiment-helpers.js";
import { agentFragmentError, normalizeAgentFragment } from "./comparison-report-shell.js";

const MAX_CONTENT_BYTES = 16_384;
const MAX_BODY_BYTES = 262_144;
const MAX_DETAILS_BYTES = 131_072;

export type ComparisonContentSnapshot = {
  content: ComparisonReportContent;
  body: string;
  details: string;
  digest: string;
};

async function readBounded(rootReal: string, path: string, maxBytes: number, optional = false): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (optional && isMissing(error)) return "";
    throw new Error(`Cannot read comparison content ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const rel = relative(rootReal, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Comparison content path escapes attempt root: ${path}`);
  const handle = await open(resolved, "r");
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > maxBytes) throw new Error(`Comparison content exceeds ${maxBytes} bytes: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally {
    await handle.close();
  }
}

export async function loadComparisonContentSnapshot(attemptRoot: string): Promise<ComparisonContentSnapshot> {
  const root = join(attemptRoot, "work", "report");
  const rootReal = await realpath(attemptRoot);
  const [raw, body, details] = await Promise.all([
    readBounded(rootReal, join(root, "content.json"), MAX_CONTENT_BYTES),
    readBounded(rootReal, join(root, "body.html"), MAX_BODY_BYTES),
    readBounded(rootReal, join(root, "details.html"), MAX_DETAILS_BYTES, true),
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid comparison content JSON at ${join(root, "content.json")}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!Value.Check(ComparisonReportContentSchema, parsed)) {
    throw new Error(`Comparison content does not satisfy schemaVersion=1 at ${join(root, "content.json")}: ${[...Value.Errors(ComparisonReportContentSchema, parsed)].map((item) => item.path || "/").join(", ")}`);
  }
  if (!parsed.headline.trim() || parsed.criticalLimitations.some((item) => !item.trim())) {
    throw new Error(`Comparison headline and limitations must contain text: ${join(root, "content.json")}`);
  }
  if (!body.trim()) throw new Error(`Comparison body is empty: ${join(root, "body.html")}`);
  for (const [name, html] of [["body.html", body], ["details.html", details]] as const) {
    const error = agentFragmentError(html);
    if (error) throw new Error(`Invalid comparison fragment ${join(root, name)}: ${error}`);
  }
  const content = parsed;
  const normalizedBody = normalizeAgentFragment(body);
  const normalizedDetails = details.trim() ? normalizeAgentFragment(details) : "";
  const digest = sha256(JSON.stringify([content, body, details.trim() ? details : ""]));
  return { content, body: normalizedBody, details: normalizedDetails, digest };
}
