import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { CLI_EXIT } from "../core/cli-protocol.js";
import { runProcess } from "../infrastructure/process-runner.js";

type Io = { stdout(message: string): void; stderr(message: string): void };

export async function runExtractCli(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs({ args: [...args], options: { output: { type: "string" } }, allowPositionals: true, strict: true });
  if (parsed.positionals.length !== 1 || !parsed.values.output) {
    io.stderr("Usage: reprise extract <file.csv|json|pdf|docx|xlsx|pptx> --output <file.json>");
    return CLI_EXIT.usage;
  }
  const source = resolve(parsed.positionals[0]!);
  const output = resolve(parsed.values.output);
  const format = extname(source).slice(1).toLowerCase();
  if (!["csv", "json", "pdf", "docx", "xlsx", "pptx"].includes(format)) {
    throw new Error("Unsupported extraction format.");
  }
  const metadata = await stat(source);
  if (!metadata.isFile() || metadata.size > 8_388_608) throw new Error("Extraction source is not a regular file under 8 MiB.");
  const sourceIdentity = await realpath(source);
  let outputIdentity: string;
  try { outputIdentity = await realpath(output); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    outputIdentity = join(await realpath(dirname(output)), basename(output));
  }
  const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (comparable(sourceIdentity) === comparable(outputIdentity)) throw new Error("Extraction output cannot overwrite its source.");
  const worker = new URL("../infrastructure/extract-worker.js", import.meta.url);
  const parsedResult = await runProcess({ operation: "extract-content", executableKind: "node", command: process.execPath,
    args: ["--max-old-space-size=128", fileURLToPath(worker), source, output, format],
    timeoutMs: 15_000, maxOutputBytes: 16_384, truncateOutput: true, killTree: true });
  io.stdout(parsedResult.stdout);
  return CLI_EXIT.ok;
}
