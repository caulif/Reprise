import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { evaluateRecoveryCases } from "../src/application/recovery/evaluation.js";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !isAbsolute(inputArg) || !isAbsolute(outputArg)) {
  throw new Error("Usage: recovery-evaluate <absolute rows.json> <absolute report.json>");
}
const parsed: unknown = JSON.parse(await readFile(resolve(inputArg), "utf8"));
if (!Array.isArray(parsed)) {
  throw new Error("Recovery evaluation input must be a JSON array of rows.");
}
const rows: readonly unknown[] = parsed;
const metrics = evaluateRecoveryCases(rows);
await writeFile(resolve(outputArg), JSON.stringify({ schemaVersion: 1, rows, metrics }, null, 2) + "\n", { flag: "wx" });
