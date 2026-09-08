import type { PackCapability, ProductPack, SessionSourceAdapter } from "./contract.js";
import type { RuntimePort } from "../core/runtime.js";
import type { CandidateSpec } from "../core/schema.js";

export function packHas(pack: ProductPack, capability: PackCapability): boolean {
  const capabilities = pack.manifest.capabilities;
  if (!capabilities || capabilities.length === 0) {
    return capability === "import" ? Boolean(pack.sessions) : Boolean(pack.runtime);
  }
  return capabilities.includes(capability);
}

export function importPacks(packs: readonly ProductPack[]): ProductPack[] {
  return packs.filter((pack) => packHas(pack, "import") && pack.sessions);
}

export function runtimePacks(packs: readonly ProductPack[]): ProductPack[] {
  return packs.filter((pack) => packHas(pack, "runtime") && pack.runtime);
}

export function packActivity(pack: ProductPack) {
  if (!pack.activity) {
    throw new Error(`Product '${pack.manifest.productId}' has no activity translator.`);
  }
  return pack.activity;
}

export function packRecoveryPlaybook(pack: ProductPack) {
  if (!pack.recoveryPlaybook) {
    throw new Error(`Product '${pack.manifest.productId}' has no recovery playbook.`);
  }
  return pack.recoveryPlaybook();
}

export function packSessions(pack: ProductPack): SessionSourceAdapter {
  if (!pack.sessions || !packHas(pack, "import")) {
    throw new Error(`Product '${pack.manifest.productId}' has no import capability.`);
  }
  return pack.sessions;
}

export function packRuntime(pack: ProductPack): RuntimePort {
  if (!pack.runtime || !packHas(pack, "runtime")) {
    throw new Error(`Product '${pack.manifest.productId}' has no runtime capability.`);
  }
  return pack.runtime;
}

export function packDefaultCandidate(pack: ProductPack): CandidateSpec {
  const candidate = pack.defaultCandidate?.();
  if (!candidate || !packHas(pack, "runtime")) {
    throw new Error(`Product '${pack.manifest.productId}' has no runtime capability.`);
  }
  return candidate;
}

export function packRoles(pack: ProductPack): readonly ("source" | "candidate")[] {
  const roles: ("source" | "candidate")[] = [];
  if (packHas(pack, "import") && pack.sessions) roles.push("source");
  if (packHas(pack, "runtime") && pack.runtime) roles.push("candidate");
  return roles;
}
