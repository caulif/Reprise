import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { sha256 } from "../../src/core/identity.js";
import { controlledFetch } from "../../src/infrastructure/controlled-fetch.js";

test("controlled fetch pins DNS, preserves bytes, and bounds redirects and response bodies", async (t) => {
  const bytes = Buffer.from("source: 中文\n");
  let mode: "ok" | "private" | "credential" | "large" = "ok";
  let calls = 0;
  t.mock.method(dns, "lookup", async (hostname: string) => [{
    address: hostname === "private.example" ? "127.0.0.1" : "93.184.216.34", family: 4,
  }]);
  t.mock.method(https, "request", (_url: URL, options: {
    lookup: (host: string, options: { all: boolean }, callback: (error: unknown, addresses: unknown) => void) => void;
    headers: Record<string, string>;
  }, callback: (response: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
    calls += 1;
    options.lookup("public.example", { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
    });
    if (mode === "credential") assert.equal(options.headers["X-Subscription-Token"], "fixture-only");
    const req = Object.assign(new EventEmitter(), {
      destroy(error: Error) { queueMicrotask(() => req.emit("error", error)); },
      end() {
        queueMicrotask(() => {
          const redirect = mode === "private" || mode === "credential";
          const response = Object.assign(new EventEmitter(), {
            statusCode: redirect ? 302 : 200,
            headers: { "content-type": "text/plain; charset=utf-8", ...(redirect ? {
              location: mode === "private" ? "https://private.example/" : "https://other.example/",
            } : {}) },
          });
          callback(response);
          response.emit("data", mode === "large" ? Buffer.alloc(2_097_153) : bytes);
          if (mode !== "large") response.emit("end");
        });
      },
    });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const actual = await controlledFetch("https://public.example/source");
  assert.deepEqual(actual.bytes, bytes);
  assert.equal(actual.contentHash, sha256(bytes));
  assert.equal(actual.finalUrl, "https://public.example/source");
  assert.equal(actual.mediaType, "text/plain; charset=utf-8");
  assert.ok(Number.isFinite(Date.parse(actual.fetchedAt)));

  mode = "private";
  calls = 0;
  await assert.rejects(controlledFetch("https://public.example/"), /public IP/);
  assert.equal(calls, 1, "private redirect must fail before a second request");

  mode = "credential";
  calls = 0;
  await assert.rejects(controlledFetch("https://public.example/", { searchKey: "fixture-only" }), /another origin/);
  assert.equal(calls, 1, "search credential must not be sent to a redirected origin");

  mode = "large";
  await assert.rejects(controlledFetch("https://public.example/"), /exceeds 2 MiB/);
  const abort = new AbortController();
  abort.abort(new Error("fixture cancellation"));
  calls = 0;
  await assert.rejects(controlledFetch("https://public.example/", { signal: abort.signal }), /fixture cancellation/);
  assert.equal(calls, 0);
});
