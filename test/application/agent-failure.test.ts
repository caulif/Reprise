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

test('only known SDK missing terminal markers are classified as transient upstream failures', () => {
  for (const message of ['Stream ended without finish_reason', 'Anthropic stream ended without a stop reason',
    'Google stream ended without a finish reason', 'proxy stream ended without a terminal event']) {
    assert.equal(classifyAgentFailure(new Error(message)), 'transient_upstream');
  }
  assert.equal(classifyAgentFailure(new Error('Stream ended without valid JSON: schema mismatch')), 'protocol');
  assert.equal(classifyAgentFailure(new Error('Application ended without a terminal event')), 'unknown');
  assert.equal(classifyAgentFailure(new Error('Missing finish_reason in a malformed response')), 'protocol');
  assert.equal(classifyAgentFailure(Object.assign(new Error('Stream ended without finish_reason'), { status: 401 })), 'authentication');
});

test('exact provider EOF is transient while tool parsing and authentication retain priority', () => {
  assert.equal(classifyAgentFailure(new Error('unexpected EOF')), 'transient_network');
  assert.equal(classifyAgentFailure(Object.assign(new Error('unexpected EOF'), { name: 'AgentToolFailure' })), 'tool');
  assert.equal(classifyAgentFailure(Object.assign(new Error('unexpected EOF'), { status: 401 })), 'authentication');
  assert.equal(classifyAgentFailure(new Error('JSON schema parsing: unexpected EOF')), 'protocol');
  assert.equal(classifyAgentFailure(new Error('Application parsing unexpected EOF')), 'unknown');
});
