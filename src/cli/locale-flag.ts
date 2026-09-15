import type { AgentLocale } from "../agents/language.js";
import { CliError } from "../application/cli-error.js";
import { parseOperatorLocale } from "../application/operator-locale.js";

export function operatorLocaleFromFlag(raw: string | undefined): AgentLocale | undefined {
  if (raw === undefined) return undefined;
  const locale = parseOperatorLocale(raw);
  if (!locale) throw new CliError("usage", "Invalid --locale. Allowed values: en, zh (aliases: english, zh-cn, chinese, 中文).");
  return locale;
}
