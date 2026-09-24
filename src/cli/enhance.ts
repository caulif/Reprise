import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CLI_EXIT } from "../core/cli-protocol.js";
import { extractMediaFrame, inspectMedia, ocrImage } from "../infrastructure/optional-enhancements.js";
import { loadToolConfig } from "../infrastructure/tool-capabilities.js";

type Io = { stdout(message: string): void; stderr(message: string): void };

export async function runEnhanceCli(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs({ args: [...args], options: {
    output: { type: "string" }, "time-ms": { type: "string" }, "data-dir": { type: "string" },
  }, allowPositionals: true, strict: true });
  const [operation, source] = parsed.positionals;
  if (!source || !parsed.values.output || !["inspect-media", "extract-frame", "ocr-text"].includes(operation ?? "")) {
    io.stderr("Usage: reprise enhance <inspect-media|extract-frame|ocr-text> <input> --output <file> [--time-ms <n>] [--data-dir <dir>]");
    return CLI_EXIT.usage;
  }
  const dataDir = resolve(parsed.values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
  const config = await loadToolConfig(dataDir);
  if (operation === "inspect-media") await inspectMedia(config, source, parsed.values.output);
  else if (operation === "ocr-text") await ocrImage(config, source, parsed.values.output);
  else {
    if (parsed.values["time-ms"] === undefined || !/^\d+$/.test(parsed.values["time-ms"])) {
      throw new Error("extract-frame requires --time-ms <integer>.");
    }
    await extractMediaFrame(config, source, parsed.values.output, Number(parsed.values["time-ms"]));
  }
  io.stdout(JSON.stringify({ ok: true, operation, output: basename(parsed.values.output) }));
  return CLI_EXIT.ok;
}
