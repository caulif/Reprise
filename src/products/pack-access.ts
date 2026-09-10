import type { PackCapability, ProductHistoryReader, ProductPack } from "./contract.js";
import type { ProductRuntime } from "../core/runtime.js";
import type { CandidateSpec } from "../core/schema.js";

export function packHas(pack: ProductPack, capability: PackCapability): boolean {
  const capabilities = pack.manifest.capabilities;
  if (!capabilities || capabilities.length === 0) {
    return capability === "import" ? Boolean(pack.history) : Boolean(pack.runtime);
  }
  return capabilities.includes(capability);
}

export function importPacks(packs: readonly ProductPack[]): ProductPack[] {
  return packs.filter((pack) => packHas(pack, "import") && pack.history);
}

export function runtimePacks(packs: readonly ProductPack[]): ProductPack[] {
  return packs.filter((pack) => packHas(pack, "runtime") && pack.runtime);
}

export function packProjection(pack: ProductPack) {
  return pack.projection;
}

export function packRecoveryPlaybook(pack: ProductPack) {
  return pack.recoveryPlaybook();
}

export function packHistory(pack: ProductPack): ProductHistoryReader {
  if (!pack.history || !packHas(pack, "import")) {
    throw new Error(`Product '${pack.manifest.productId}' has no import capability.`);
  }
  return pack.history;
}

export function packRuntime(pack: ProductPack): ProductRuntime {
  if (!pack.runtime || !packHas(pack, "runtime")) {
    throw new Error(`Product '${pack.manifest.productId}' has no runtime capability.`);
  }
  return pack.runtime;
}

export function packDefaultCandidate(pack: ProductPack): CandidateSpec {
  const candidate = pack.defaultCandidate();
  if (!candidate || !packHas(pack, "runtime")) {
    throw new Error(`Product '${pack.manifest.productId}' has no runtime capability.`);
  }
  return candidate;
}

export function packRoles(pack: ProductPack): readonly ("source" | "candidate")[] {
  const roles: ("source" | "candidate")[] = [];
  if (packHas(pack, "import") && pack.history) roles.push("source");
  if (packHas(pack, "runtime") && pack.runtime) roles.push("candidate");
  return roles;
}
