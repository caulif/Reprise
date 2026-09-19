import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentFailure } from '../../src/infrastructure/agent/failure.js';
import { retryableRecoveryFailure } from '../../src/application/recovery/fail.js';

test('HTTP/2 and undici abort are transient, not cancelled or unknown', () => {
  const http2 = classifyAgentFailure(new Error('Upstream HTTP/2 stream failed'));
  const undici = classifyAgentFailure(Object.assign(new Error('Request was aborted'), { name: 'AbortError' }));
  const fetchFailed = classifyAgentFailure(new Error('TypeError: fetch failed'));
  assert.equal(http2, 'transient_network');
  assert.equal(undici, 'transient_network');
  assert.equal(fetchFailed, 'transient_network');
  assert.equal(retryableRecoveryFailure({
    status: 'failed',
    sessionId: 'recovery-1',
    failure: { code: 'agent_failure', message: 'Upstream HTTP/2 stream failed', attempts: 1, kind: http2 },
  } as never), 'agent_failure');
});

test('operator abort stays cancelled and is not retried', () => {
  const cancelled = classifyAgentFailure(Object.assign(new Error('Pi model request was aborted.'), { name: 'AbortError' }));
  assert.equal(cancelled, 'cancelled');
  assert.equal(retryableRecoveryFailure({
    status: 'failed',
    sessionId: 'recovery-1',
    failure: { code: 'agent_failure', message: 'Pi model request was aborted.', attempts: 1, kind: cancelled },
  } as never), undefined);
});

test('HTTP 520 is transient_upstream and recovery-retryable', () => {
  const kind = classifyAgentFailure(Object.assign(new Error('HTTP 520'), { status: 520 }));
  assert.equal(kind, 'transient_upstream');
  assert.equal(retryableRecoveryFailure({
    status: 'failed',
    sessionId: 'recovery-1',
    failure: { code: 'agent_failure', message: 'HTTP 520', attempts: 1, kind },
  } as never), 'agent_failure');
});

test('unknown failure kind is not recovery-retried', () => {
  assert.equal(retryableRecoveryFailure({
    status: 'failed',
    sessionId: 'recovery-1',
    failure: { code: 'agent_failure', message: 'HTTP 418', attempts: 1, kind: 'unknown' },
  } as never), undefined);
});
