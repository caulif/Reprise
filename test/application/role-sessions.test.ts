import test from "node:test";
import assert from "node:assert/strict";
import { RoleSessions } from "../../src/infrastructure/agent/role-sessions.js";
import type { AgentSessionHost } from "../../src/infrastructure/agent/session.js";

function session(id: string, close: () => Promise<void> = async () => {}): AgentSessionHost {
  return {
    sessionId: id,
    close,
  } as AgentSessionHost;
}

test("RoleSessions reuses one in-flight create per key", async () => {
  const sessions = new RoleSessions();
  let created = 0;
  const first = sessions.get("a", async () => {
    created += 1;
    await Promise.resolve();
    return session("a");
  });
  const second = sessions.get("a", async () => {
    created += 1;
    return session("a-other");
  });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.session, right.session);
  assert.equal(left.created, true);
  assert.equal(right.created, false);
  assert.equal(created, 1);
  const again = await sessions.get("a", async () => session("a-new"));
  assert.equal(again.created, false);
  assert.equal(again.session, left.session);
});

test("RoleSessions drops a failed create so the next get retries", async () => {
  const sessions = new RoleSessions();
  let attempts = 0;
  await assert.rejects(sessions.get("a", async () => {
    attempts += 1;
    throw new Error("create failed");
  }), /create failed/);
  const recovered = await sessions.get("a", async () => {
    attempts += 1;
    return session("a");
  });
  assert.equal(recovered.session.sessionId, "a");
  assert.equal(recovered.created, true);
  assert.equal(attempts, 2);
});

test("RoleSessions cancel isolates keys", async () => {
  const sessions = new RoleSessions();
  const cancelled: string[] = [];
  await sessions.get("keep", async () => session("keep"));
  await sessions.get("drop", async () => session("drop"));
  await sessions.cancel("drop", async (item) => {
    cancelled.push(item.sessionId);
  });
  assert.deepEqual(cancelled, ["drop"]);
  assert.deepEqual([...sessions.keys()], ["keep"]);
});

test("RoleSessions discard closes a created Session after a failed request", async () => {
  const sessions = new RoleSessions();
  let closed = 0;
  await sessions.get("a", async () => session("a", async () => {
    closed += 1;
  }));
  await sessions.discard("a");
  assert.equal(closed, 1);
  assert.deepEqual([...sessions.keys()], []);
  await sessions.get("a", async () => session("a-retry", async () => {}));
  assert.deepEqual([...sessions.keys()], ["a"]);
});

test("RoleSessions discard surfaces close failure", async () => {
  const sessions = new RoleSessions();
  await sessions.get("a", async () => session("a", async () => {
    throw new Error("close failed");
  }));
  await assert.rejects(sessions.discard("a"), /close failed/);
  assert.deepEqual([...sessions.keys()], []);
});

test("RoleSessions release waits for close and surfaces close failure", async () => {
  const sessions = new RoleSessions();
  let closed = false;
  await sessions.get("a", async () => session("a", async () => {
    closed = true;
    throw new Error("close failed");
  }));
  await assert.rejects(sessions.release("a"), /close failed/);
  assert.equal(closed, true);
  assert.deepEqual([...sessions.keys()], []);
});
