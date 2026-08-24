import { hasFileApiKey, tryEnvironmentName, type HarnessConfigDraft, type HarnessModelConfig, shellEnvAssignment } from "../infrastructure/harness-model-config.js";
import { PiModelCaller } from "../infrastructure/pi-model-caller.js";

function envUnsetMessage(keyRef: string): string | undefined {
  const name = tryEnvironmentName(keyRef);
  if (!name || process.env[name]) return undefined;
  return `${name} is not set in this shell. ${shellEnvAssignment(name)}`;
}

export function credentialGapMessage(draft: HarnessConfigDraft): string | undefined {
  if (draft.kind !== "openai-compatible") return undefined;
  if (hasFileApiKey(draft)) return undefined;
  const unset = envUnsetMessage(draft.keyRef);
  if (unset) return unset;
  if (!draft.keyRef.trim()) {
    return "Add an API key to .reprise/harness-model.json, or an env:NAME reference.";
  }
  return undefined;
}

export function harnessCaller(
  config: HarnessModelConfig,
  catalog?: ConstructorParameters<typeof PiModelCaller>[1],
): PiModelCaller {
  return config.schemaVersion === 2 &&
    config.provider.kind === "openai-compatible"
    ? new PiModelCaller(config)
    : new PiModelCaller(config, catalog);
}
