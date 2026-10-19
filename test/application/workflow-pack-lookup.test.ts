import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperimentWorkflow } from "../../src/application/experiment-workflow.js";
import { preflightExperiment } from "../../src/application/experiment-preflight.js";
import { createProductLookup, productPacks } from "../../src/products/index.js";
import type { ProductRuntime } from "../../src/core/runtime.js";
import type { ProductPack } from "../../src/products/contract.js";
import { codexProductPack } from "../../src/products/packs/codex/pack.js";
import { input, VerifiedRuntime, now } from "../codex-experiment-support.js";
import { createHarnessAgents, type HarnessAgents } from '../../src/application/harness-agents.js';
import { defaultHarnessModelConfig } from '../../src/infrastructure/harness-model-config.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';

class LocalRuntime implements ProductRuntime {
  readonly id = "local-test";
  readonly delegate = new VerifiedRuntime();
  get created() { return this.delegate.created; }
  constructor(readonly productId: string, readonly model: string) {}
  async inspectAvailable() {
    return [{ productId: this.productId, executable: "verified-test", version: "fixture" }];
  }
  async inspectAvailability() {
    return [{ productId: this.productId, executable: "verified-test", observedVersion: "fixture", status: "available" as const, observedAt: now }];
  }
  async listCatalog() {
    return [{ value: this.model, displayName: this.model, resolvedModel: this.model }];
  }
  validateCandidate(request: { productId: string; requestedModel: string }) { return this.resolve(request); }
  recoveryCapabilities() { return this.delegate.recoveryCapabilities(); }
  createRunner(...args: Parameters<VerifiedRuntime["createRunner"]>) { return this.delegate.createRunner(...args); }
  async resolve(request: { productId: string; requestedModel: string }) {
    return { ...await this.delegate.resolve(request), productId: this.productId, resolvedModel: this.model };
  }
}

function localPack(runtime: LocalRuntime): ProductPack {
  return {
    ...codexProductPack,
    manifest: { ...codexProductPack.manifest, productId: runtime.productId },
    runtime,
    defaultCandidate: () => ({ ...codexProductPack.defaultCandidate(), productId: runtime.productId, requestedModel: runtime.model }),
  };
}

async function fixture(t: TestContext, pack: ProductPack, runtime?: ProductRuntime,
  buildAgents?: (base: ReturnType<typeof input>) => HarnessAgents) {
  const root = await mkdtemp(join(tmpdir(), "reprise-workflow-lookup-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const taskCase = { ...base.taskCase, source: { ...base.taskCase.source, productId: pack.manifest.productId } };
  const workflow = createExperimentWorkflow({
    dataDir: base.dataDir,
    lookup: createProductLookup([pack]),
    ...(runtime ? { runtime } : {}),
    now: () => now,
    agents: async () => {
      if (buildAgents) return buildAgents(base);
      throw new Error("Read-only operations must not initialize agents.");
    },
  });
  return { base, taskCase, workflow, preflight: { taskCase, sourceRoot: base.sourceRoot } };
}

for (const productId of ['local-only', 'codex']) test(`injected ${productId} projections remain local through steering, completion and persisted comparison`, async t => {
  for (const marker of ['first-local-projection', 'second-local-projection']) {
    const runtime = new LocalRuntime(productId, marker);
    let inspections = 0, steering = 0, comparisons = 0;
    const local = localPack(runtime);
    const pack: ProductPack = { ...local, manifest: { ...local.manifest, displayName: `Agent ${marker}` }, projection: {
      inspectRunFacts(events) {
        inspections++;
        return { ...codexProductPack.projection.inspectRunFacts(events), assistantTexts: [marker], finalMessage: marker };
      },
      projectTurn(request) {
        return { ...codexProductPack.projection.projectTurn(request), assistantText: marker };
      },
    } };
    const f = await fixture(t, pack, undefined, base => {
      const agents = createHarnessAgents(defaultHarnessModelConfig(), {
        createSession: () => { throw new Error('This regression must not request a real model session.'); },
      });
      t.mock.method(agents.controller, 'decide', async (...[context, ...args]: Parameters<HarnessAgents['controller']['decide']>) => {
        if (context.phase === 'steering') {
          steering++;
          assert.match(await readFile(join(context.briefingRoot!, 'current-user-view.md'), 'utf8'), new RegExp(marker));
        }
        return base.controller.decide(context, ...args);
      });
      t.mock.method(agents.comparison, 'compare', async (context: Parameters<HarnessAgents['comparison']['compare']>[0]) => {
        assert.deepEqual(context.reportFacts.sessionAgents, { baseline: pack.manifest.displayName, candidate: pack.manifest.displayName });
        comparisons++;
        return { status: 'cancelled' as const, sessionId: 'fixture-comparison' };
      });
      return agents;
    });
    const candidate = { ...f.base.candidate, productId, requestedModel: marker };
    const handle = await f.workflow.start({ taskCase: f.taskCase, sourceRoot: f.base.sourceRoot, candidate,
      experimentId: f.base.experimentId, runId: f.base.runId, compare: true, onEvent: () => {} });
    const result = await handle.result;
    assert.equal(comparisons, 1, JSON.stringify(result.comparison));
    assert.equal(result.comparison.result.status, 'cancelled');
    assert.equal(steering, 1);
    assert.equal(result.record.attempt.candidate.productId, productId);
    assert.equal(result.record.manifest?.resolvedModel.resolved, marker);
    const store = await ExperimentStore.open(result.experimentRoot, f.base.experimentId);
    assert.ok(store.events(f.base.runId).some(event => event.type === 'candidate.user_view_persisted'
      && typeof event.payload === 'object' && event.payload !== null && 'assistantText' in event.payload && event.payload.assistantText === marker));
    await store.close();
    const beforeReopen = inspections;
    const compared = await f.workflow.comparePersisted(f.base.experimentId, undefined, undefined, f.base.runId);
    assert.ok(inspections > beforeReopen, 'persisted comparison must use this workflow projection');
    assert.equal(comparisons, 2);
    assert.deepEqual(compared.record, result.record);
    assert.equal(compared.comparison.result.status, 'cancelled');
  }
  if (productId === 'local-only') assert.equal(productPacks.some(pack => pack.manifest.productId === productId), false);
});

test("independent Pack preflight succeeds without global activation or execution", async (t) => {
  const runtime = new LocalRuntime("local-only", "local-model");
  const pack = localPack(runtime);
  assert.equal(productPacks.some((item) => item.manifest.productId === "local-only"), false);
  const f = await fixture(t, pack);
  const result = await f.workflow.preflight(f.preflight);
  assert.equal(result.resolved.productId, "local-only");
  assert.equal(result.resolved.resolvedModel, "local-model");
  assert.equal(runtime.created, 0);
  assert.deepEqual(await readdir(f.base.sourceRoot), []);
});

test("workflow lookups with the same product id keep independent runtimes", async (t) => {
  const first = await fixture(t, localPack(new LocalRuntime("local-only", "first-model")));
  const second = await fixture(t, localPack(new LocalRuntime("local-only", "second-model")));
  for (const [f, model] of [[first, "first-model"], [second, "second-model"]] as const) {
    assert.equal((await f.workflow.listCatalog("local-only"))[0]?.value, model);
    assert.equal((await f.workflow.inspectAvailability("local-only"))[0]?.productId, "local-only");
    assert.equal((await f.workflow.verifyCandidate({ ...f.base.candidate, productId: "local-only" })).resolvedModel, model);
    assert.equal((await f.workflow.preflight(f.preflight)).resolved.resolvedModel, model);
  }
  assert.equal(productPacks.some((item) => item.manifest.productId === "local-only"), false);
});

test("explicit runtime override is shared by catalog, availability, verification and preflight", async (t) => {
  const f = await fixture(t, localPack(new LocalRuntime("local-only", "pack-model")), new LocalRuntime("local-only", "override-model"));
  assert.equal((await f.workflow.listCatalog("local-only"))[0]?.value, "override-model");
  assert.equal((await f.workflow.inspectAvailability("local-only"))[0]?.productId, "local-only");
  assert.equal((await f.workflow.verifyCandidate({ ...f.base.candidate, productId: "local-only" })).resolvedModel, "override-model");
  assert.equal((await f.workflow.preflight(f.preflight)).resolved.resolvedModel, "override-model");
});

test("local lookup rejects unknown products and runtime capability mismatches", async (t) => {
  const runtime = new LocalRuntime("local-only", "local-model");
  const f = await fixture(t, localPack(runtime));
  await assert.rejects(async () => f.workflow.preflight({ ...f.preflight, candidate: { ...f.base.candidate, productId: "missing" } }), /Unknown product 'missing'/);
  const importOnly = localPack(runtime);
  const incapable = await fixture(t, { ...importOnly, manifest: { ...importOnly.manifest, capabilities: ["import"] } }, runtime);
  await assert.rejects(async () => incapable.workflow.preflight({ ...incapable.preflight, candidate: { ...incapable.base.candidate, productId: "local-only" } }), /no runtime capability/);
  await assert.rejects(async () => incapable.workflow.listCatalog("local-only"), /no runtime capability/);
});

test("mismatched runtime override cannot verify a different product", async (t) => {
  const f = await fixture(t, localPack(new LocalRuntime("local-only", "local-model")), new LocalRuntime("other-product", "other-model"));
  await assert.rejects(f.workflow.preflight(f.preflight), /does not match resolved runtime product 'other-product'/);
  await assert.rejects(f.workflow.verifyCandidate({ ...f.base.candidate, productId: "local-only" }), /does not match resolved runtime product/);
  const pending = await f.workflow.preflight({ ...f.preflight, verifyCandidate: false });
  assert.equal(pending.resolved.productId, "local-only");
  assert.equal(pending.resolved.executable, "unresolved");
  assert.equal(pending.resolved.resolvedModel, "pending");
});

test("preflight lower-level runtime validation keeps unknown models unverified", async (t) => {
  const runtime = new LocalRuntime("local-only", "unknown");
  const f = await fixture(t, localPack(runtime));
  await assert.rejects(preflightExperiment({ ...f.base, runtime, taskCase: f.taskCase, candidate: { ...f.base.candidate, productId: "local-only" } }), /model is not verified/);
  const pending = await f.workflow.preflight({ ...f.preflight, verifyCandidate: false });
  assert.equal(pending.resolved.productId, "local-only");
  assert.equal(pending.resolved.executable, "verified-test");
});
