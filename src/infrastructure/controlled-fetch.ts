import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { sha256 } from "../core/identity.js";

const MAX_BYTES = 2_097_152;
const MAX_REDIRECTS = 3;
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001:db8::", 32], ["2001:10::", 28], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(address, prefix, "ipv6");

export type ControlledFetchResult = {
  bytes: Buffer;
  finalUrl: string;
  fetchedAt: string;
  contentHash: string;
  mediaType: string;
  status: number;
  redirects: string[];
};

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || (family === 4 ? blockedV4.check(address, "ipv4")
    : address.toLowerCase().startsWith("::ffff:") || blockedV6.check(address, "ipv6"))) {
    throw new Error("Network target is not a public IP address.");
  }
  if (family === 6 && !address.toLowerCase().startsWith("2") && !address.toLowerCase().startsWith("3")) {
    throw new Error("Network target is outside public unicast IPv6 space.");
  }
}

export async function controlledFetch(rawUrl: string, options: { signal?: AbortSignal; searchKey?: string } = {}): Promise<ControlledFetchResult> {
  let current = new URL(rawUrl);
  const redirects: string[] = [];
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    if (current.protocol !== "https:" || current.username || current.password || current.port && current.port !== "443") {
      throw new Error("Only public HTTPS URLs on port 443 are allowed.");
    }
    if (options.searchKey && redirects.length && new URL(redirects[0]!).origin !== current.origin) {
      throw new Error("Authenticated search cannot redirect to another origin.");
    }
    const addresses = await abortable(lookup(current.hostname, { all: true }), signal);
    if (!addresses.length) throw new Error("Network target has no DNS address.");
    for (const item of addresses) assertPublicAddress(item.address);
    const selected = addresses[0]!;
    const response = await fetchHop(current, selected, { signal,
      ...(options.searchKey ? { searchKey: options.searchKey } : {}) });
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (count === MAX_REDIRECTS) throw new Error("Network redirect limit exceeded.");
      redirects.push(current.href);
      current = new URL(response.location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Network source returned HTTP ${response.status}.`);
    return { bytes: response.bytes, finalUrl: current.href, fetchedAt: new Date().toISOString(),
      contentHash: sha256(response.bytes), mediaType: response.mediaType, status: response.status, redirects };
  }
  throw new Error("Network redirect limit exceeded.");
}

function fetchHop(url: URL, selected: { address: string; family: number }, options: { signal: AbortSignal; searchKey?: string }): Promise<{
  bytes: Buffer; status: number; mediaType: string; location?: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", timeout: 10_000, signal: options.signal,
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === "object" && lookupOptions.all) {
          (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [selected]);
        } else {
          (callback as (error: null, address: string, family: number) => void)(null, selected.address, selected.family);
        }
      },
      headers: { Accept: "text/html, text/plain, application/json, */*;q=0.1",
        ...(options.searchKey ? { "X-Subscription-Token": options.searchKey } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_BYTES) { req.destroy(new Error("Network response exceeds 2 MiB.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks), status: response.statusCode ?? 0,
        mediaType: String(response.headers["content-type"] ?? "application/octet-stream").slice(0, 128),
        ...(response.headers.location ? { location: response.headers.location } : {}) }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Network request timed out.")));
    req.on("error", reject);
    req.end();
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Network request cancelled.");
}
