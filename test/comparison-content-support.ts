import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadComparisonContentSnapshot } from "../src/application/comparison-report-content.js";

export async function writeComparisonContent(root: string, body: string, headline = "两侧结果可供核对。") {
  const directory = join(root, "work", "report");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "content.json"), JSON.stringify({
    schemaVersion: 1, headline, criticalLimitations: [], evidenceRefs: [],
  }));
  await writeFile(join(directory, "body.html"), body);
  return loadComparisonContentSnapshot(root);
}
