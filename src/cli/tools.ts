import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CLI_EXIT } from "../core/cli-protocol.js";
import { detectToolCapabilities, isBraveSearchEndpoint, loadToolConfig, saveToolConfig } from "../infrastructure/tool-capabilities.js";
import { runProcess } from "../infrastructure/process-runner.js";

type Io = { stdout(message: string): void; stderr(message: string): void };

const options = {
  "data-dir": { type: "string" }, json: { type: "boolean" }, browser: { type: "boolean" },
  "browser-path": { type: "string" }, "search-endpoint": { type: "string" }, "search-key-env": { type: "string" },
  "libreoffice-path": { type: "string" }, "ffmpeg-path": { type: "string" },
  "ffprobe-path": { type: "string" }, "tesseract-path": { type: "string" },
} as const;

export async function runToolsCli(command: "doctor" | "setup", args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "tools") {
    io.stderr(`Usage: reprise ${command} tools [--data-dir <dir>] [--json]${command === "setup" ? " [--browser|--browser-path <path>|--search-endpoint <https-url> --search-key-env <name>|--ffmpeg-path <path> ...]" : ""}`);
    return CLI_EXIT.usage;
  }
  const dataDir = resolve(parsed.values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
  const config = await loadToolConfig(dataDir);
  if (command === "setup") {
    const endpoint = parsed.values["search-endpoint"];
    const keyEnv = parsed.values["search-key-env"];
    if (Boolean(endpoint) !== Boolean(keyEnv)) throw new Error("Search setup requires both --search-endpoint and --search-key-env.");
    if (endpoint) {
      const url = new URL(endpoint);
      if (!isBraveSearchEndpoint(url.href)) throw new Error("Search endpoint must be the Brave Search web API: https://api.search.brave.com/res/v1/web/search.");
    }
    const enhancements = {
      ...config.enhancements,
      ...(parsed.values["libreoffice-path"] ? { libreOfficePath: resolve(parsed.values["libreoffice-path"]) } : {}),
      ...(parsed.values["ffmpeg-path"] ? { ffmpegPath: resolve(parsed.values["ffmpeg-path"]) } : {}),
      ...(parsed.values["ffprobe-path"] ? { ffprobePath: resolve(parsed.values["ffprobe-path"]) } : {}),
      ...(parsed.values["tesseract-path"] ? { tesseractPath: resolve(parsed.values["tesseract-path"]) } : {}),
    };
    const updated = { ...config,
      ...(parsed.values["browser-path"] ? { browserPath: resolve(parsed.values["browser-path"]) } : {}),
      ...(endpoint && keyEnv ? { search: { endpoint, keyEnv } } : {}),
      ...(Object.keys(enhancements).length ? { enhancements } : {}),
    };
    if (parsed.values.browser) {
      const require = createRequire(import.meta.url);
      const cliPath = join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
      await runProcess({ operation: "install-chromium", executableKind: "node", command: process.execPath,
        args: [cliPath, "install", "chromium"], timeoutMs: 600_000, maxOutputBytes: 8192, truncateOutput: true, killTree: true });
    }
    await saveToolConfig(dataDir, updated);
  }
  const { manifest } = await detectToolCapabilities(command === "setup" ? await loadToolConfig(dataDir) : config, new Date(), command === "setup");
  if (parsed.values.json) io.stdout(JSON.stringify({ ok: true, command: `${command} tools`, data: manifest }));
  else io.stdout(formatManifest(manifest));
  return CLI_EXIT.ok;
}

function formatManifest(manifest: Awaited<ReturnType<typeof detectToolCapabilities>>["manifest"]): string {
  return [...manifest.core, ...manifest.optional].map((item) =>
    `${item.id}: ${item.available ? "available" : "unavailable"}${item.version ? ` (${item.version})` : ""}${item.reason ? ` - ${item.reason}` : ""}`,
  ).join("\n");
}
