import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicAddress, controlledFetch } from "../../src/infrastructure/controlled-fetch.js";

test("controlled fetch rejects local and private destinations before a request", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.throws(() => assertPublicAddress(address), /public/i);
  }
  assert.doesNotThrow(() => assertPublicAddress("8.8.8.8"));
  await assert.rejects(controlledFetch("https://127.0.0.1/"), /public/i);
  await assert.rejects(controlledFetch("http://example.com/"), /HTTPS/i);
});
