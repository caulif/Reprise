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

test('message-only HTTP 520 (Pi Recovery shape) is transient_upstream and recovery-retryable', () => {
  const cloudflare = classifyAgentFailure(
    new Error('520 Web Server Returned an Unknown Error: <html>upstream blip</html>'),
  );
  const httpLabel = classifyAgentFailure(new Error('HTTP 520'));
  assert.equal(cloudflare, 'transient_upstream');
  assert.equal(httpLabel, 'transient_upstream');
  assert.equal(retryableRecoveryFailure({
    status: 'failed',
    sessionId: 'recovery-1',
    failure: {
      code: 'agent_failure',
      message: '520 Web Server Returned an Unknown Error: <html>upstream blip</html>',
      attempts: 1,
      kind: cloudflare,
    },
  } as never), 'agent_failure');
});

test('unknown failure kind is not recovery-retried', () => {
  assert.equal(classifyAgentFailure(new Error('HTTP 418')), 'unknown');
  assert.equal(classifyAgentFailure(new Error('I\'m a teapot')), 'unknown');
  assert.equal(retryableRecoveryFailure({
    status: 'failed',
    sessionId: 'recovery-1',
    failure: { code: 'agent_failure', message: 'HTTP 418', attempts: 1, kind: 'unknown' },
  } as never), undefined);
});
