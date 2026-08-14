import type { ProductAuthStatus, ProductPack } from '../../../src/products/contract.js';
import { fakeActivityTranslator } from './activity.js';
import { FakeRuntimePort } from './runtime.js';
import { fakeSessionAdapter } from './sessions.js';

export const fakeProductPack: ProductPack = {
  manifest: {
    productId: 'fake',
    displayName: 'Fake',
    packVersion: '0.0.0',
    schemaVersion: 1,
    sessionSchemaVersions: ['fake-session-jsonl/v1'],
  },
  sessions: fakeSessionAdapter,
  runtime: new FakeRuntimePort(),
  activity: fakeActivityTranslator,
  recoveryPlaybook: () => ({ version: 'fake-recovery/v1', sha256: '0'.repeat(64), text: '# Fake recovery\n' }),
  async checkAuth(): Promise<ProductAuthStatus> {
    return { configured: true, provider: 'fake', source: 'fixture' };
  },
  defaultCandidate: () => ({ candidateId: 'fake-default', productId: 'fake', requestedModel: 'fake-model' }),
};
