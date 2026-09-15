import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLocale } from "../agents/language.js";
import { isRecord } from "../core/json.js";

/** Same file as TUI preferences; application reads locale without importing tui. */
const FILE_NAME = "tui-preferences.json";

/** CLI `--locale` and preferences aliases. Unknown non-empty values are not defaulted to zh. */
export function parseOperatorLocale(raw: string | undefined): AgentLocale | undefined {
  if (raw === undefined) return undefined;
  const locale = raw.trim().toLowerCase();
  if (locale === "en" || locale === "english") return "en";
  if (locale === "zh" || locale === "zh-cn" || locale === "chinese" || locale === "中文") return "zh";
  return undefined;
}

export async function readOperatorLocale(dataDir: string): Promise<AgentLocale> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, FILE_NAME), "utf8")) as unknown;
    if (!isRecord(value) || typeof value.locale !== "string") return "zh";
    return parseOperatorLocale(value.locale) ?? "zh";
  } catch {
    // Missing or unreadable preferences are not an experiment failure; default locale is zh.
    return "zh";
  }
}
