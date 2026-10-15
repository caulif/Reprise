import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { EffectiveHarnessConfigurationSchema, HarnessConfigurationBoundSchema, HarnessProbeRequestedSchema, HarnessProbeCompletedSchema,
  type EffectiveHarnessConfiguration, type HarnessConfigurationReference } from '../core/schema.js';
import { canonicalJson } from '../core/task-case-identity.js';
import { sha256 } from '../core/identity.js';
import { frozenSnapshot } from '../core/json.js';
import type { ExperimentStore } from '../infrastructure/store/experiment-store.js';
import type { HarnessProbeAudit } from '../infrastructure/agent/model-caller.js';

export type HarnessConfigurationScope = {
  bind(configuration: EffectiveHarnessConfiguration): Promise<{ reference: HarnessConfigurationReference; probeAudit: HarnessProbeAudit }>;
};

export function harnessConfigurationScope(store: ExperimentStore, owner: Pick<HarnessConfigurationReference, 'experimentId' | 'runId' | 'operation' | 'comparisonAttemptId'>,
  onBound?: (reference: HarnessConfigurationReference) => void): HarnessConfigurationScope {
  return {
    async bind(configuration) {
      if (!Value.Check(EffectiveHarnessConfigurationSchema, configuration)) throw new Error('Invalid effective Harness configuration.');
      const configurationId = `config-${randomUUID()}`;
      const bytes = Buffer.from(canonicalJson(configuration));
      const artifact = await store.commitArtifact({ artifactId: `${configurationId}.json`, runId: owner.runId,
        kind: 'harness_effective_configuration', mediaType: 'application/json', bytes });
      const reference = frozenSnapshot({ ...owner, configurationId, artifactId: artifact.artifactId, contentHash: sha256(bytes) });
      const payload = { schemaVersion: 1 as const, reference, configuration };
      if (!Value.Check(HarnessConfigurationBoundSchema, payload)) throw new Error('Invalid Harness configuration ownership.');
      await store.append({ type: 'harness.configuration_bound', runId: owner.runId, payload });
      onBound?.(reference);
      return { reference, probeAudit: {
        async requested(request) {
          const payload = { schemaVersion: 1 as const, reference, ...request };
          if (!Value.Check(HarnessProbeRequestedSchema, payload)) throw new Error('Invalid Harness probe request audit.');
          await store.append({ type: 'harness.probe_requested', runId: owner.runId, payload });
        },
        async completed(result) {
          const payload = { schemaVersion: 1 as const, reference, ...result };
          if (!Value.Check(HarnessProbeCompletedSchema, payload)) throw new Error('Invalid Harness probe completion audit.');
          await store.append({ type: 'harness.probe_completed', runId: owner.runId, payload });
        },
      } };
    },
  };
}
