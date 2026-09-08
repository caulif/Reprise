import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { PACK_API_MAJOR, type ProductPack } from "./contract.js";
import { packHas } from "./pack-access.js";

export type PackLoadDiagnostic = {
  readonly specifier: string;
  readonly code: "duplicate_product_id" | "incompatible_api_major" | "invalid_export" | "capability_mismatch" | "raw_typescript" | "load_failed";
  readonly message: string;
  readonly productId?: string;
};

export type AssembledPacks = {
  readonly packs: readonly ProductPack[];
  readonly diagnostics: readonly PackLoadDiagnostic[];
};

const PluginConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  packs: Type.Array(Type.Object({
    module: Type.Optional(Type.String({ minLength: 1 })),
    package: Type.Optional(Type.String({ minLength: 1 })),
  })),
});

export async function assembleProductPacks(
  dataDir: string,
  builtins: readonly ProductPack[],
): Promise<AssembledPacks> {
  const listed = await readPluginSpecifiers(dataDir);
  const diagnostics: PackLoadDiagnostic[] = [...listed.diagnostics];
  const packs: ProductPack[] = [];
  for (const pack of builtins) {
    acceptPack(pack, "builtin", packs, diagnostics);
  }
  for (const specifier of listed.specifiers) {
    const loaded = await loadSpecifier(specifier, resolve(dataDir));
    if ("diagnostic" in loaded) {
      diagnostics.push(loaded.diagnostic);
      continue;
    }
    acceptPack(loaded.pack, specifier, packs, diagnostics);
  }
  return { packs, diagnostics };
}

async function readPluginSpecifiers(dataDir: string): Promise<{ specifiers: string[]; diagnostics: PackLoadDiagnostic[] }> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dataDir, "plugins.json"), "utf8"));
    if (!Value.Check(PluginConfigSchema, raw)) {
      return { specifiers: [], diagnostics: [{ specifier: "plugins.json", code: "invalid_export", message: "plugins.json must use schemaVersion 1 and packs entries with exactly one of module or package." }] };
    }
    const specifiers: string[] = [];
    const diagnostics: PackLoadDiagnostic[] = [];
    for (const entry of raw.packs) {
      if (entry.module && !entry.package) specifiers.push(entry.module);
      else if (entry.package && !entry.module) specifiers.push(entry.package);
      else diagnostics.push({ specifier: "plugins.json", code: "invalid_export", message: "Each packs entry needs exactly one of module or package." });
    }
    return { specifiers, diagnostics };
  } catch (error) {
    if (isEnoent(error)) return { specifiers: [], diagnostics: [] };
    return {
      specifiers: [],
      diagnostics: [{ specifier: "plugins.json", code: "load_failed", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function loadSpecifier(specifier: string, baseDir: string): Promise<{ pack: ProductPack } | { diagnostic: PackLoadDiagnostic }> {
  if (isRawTypeScript(specifier)) {
    return { diagnostic: { specifier, code: "raw_typescript", message: "Pack modules must be JavaScript or compiled output, not raw TypeScript." } };
  }
  try {
    const href = await resolveSpecifier(specifier, baseDir);
    const module = await import(href) as { pack?: unknown; default?: unknown };
    const pack = asProductPack(module.pack ?? module.default);
    if (!pack) {
      return { diagnostic: { specifier, code: "invalid_export", message: "Module must export { pack } or default ProductPack." } };
    }
    return { pack };
  } catch (error) {
    return {
      diagnostic: {
        specifier,
        code: "load_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function acceptPack(pack: ProductPack, specifier: string, packs: ProductPack[], diagnostics: PackLoadDiagnostic[]): void {
  if (pack.manifest.apiMajor !== PACK_API_MAJOR) {
    diagnostics.push({
      specifier,
      code: "incompatible_api_major",
      message: `Pack API major ${pack.manifest.apiMajor} is not ${PACK_API_MAJOR}.`,
      productId: pack.manifest.productId,
    });
    return;
  }
  const mismatch = capabilityMismatch(pack);
  if (mismatch) {
    diagnostics.push({ specifier, code: "capability_mismatch", message: mismatch, productId: pack.manifest.productId });
    return;
  }
  if (packs.some((item) => item.manifest.productId === pack.manifest.productId)) {
    diagnostics.push({
      specifier,
      code: "duplicate_product_id",
      message: `productId '${pack.manifest.productId}' is already registered.`,
      productId: pack.manifest.productId,
    });
    return;
  }
  packs.push(pack);
}

function capabilityMismatch(pack: ProductPack): string | undefined {
  if (packHas(pack, "import")) {
    if (!pack.sessions) return "import capability requires sessions.";
    if (typeof pack.sessions.discover !== "function" || typeof pack.sessions.inspect !== "function" || typeof pack.sessions.import !== "function") {
      return "import capability requires discover, inspect, and import functions.";
    }
  }
  if (packHas(pack, "runtime")) {
    if (!pack.runtime || !pack.defaultCandidate || !pack.activity) {
      return "runtime capability requires runtime, activity, and defaultCandidate.";
    }
    if (typeof pack.runtime.validateCandidate !== "function" || typeof pack.runtime.listCatalog !== "function" || typeof pack.runtime.createRunner !== "function") {
      return "runtime capability requires validateCandidate, listCatalog, and createRunner.";
    }
    if (typeof pack.activity.translate !== "function") return "runtime capability requires activity.translate.";
  }
  if (pack.manifest.capabilities.length === 0) return "capabilities must not be empty.";
  return undefined;
}

function asProductPack(value: unknown): ProductPack | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pack = value as ProductPack;
  if (!pack.manifest || typeof pack.manifest.productId !== "string") return undefined;
  if (!Array.isArray(pack.manifest.capabilities) || typeof pack.manifest.apiMajor !== "number") return undefined;
  return pack;
}

function isRawTypeScript(specifier: string): boolean {
  return [".ts", ".mts", ".tsx", ".cts"].includes(extname(specifier).toLowerCase());
}

async function resolveSpecifier(specifier: string, baseDir: string): Promise<string> {
  if (specifier.startsWith(".") || specifier.startsWith("/") || isAbsolute(specifier) || specifier.includes("\\")) {
    return pathToFileURL(resolve(baseDir, specifier)).href;
  }
  const require = createRequire(join(baseDir, "package.json"));
  return pathToFileURL(require.resolve(specifier)).href;
}
