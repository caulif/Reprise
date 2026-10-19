import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessionsByProject, renderSessions } from '../../src/tui/pages/intake.js';
import { createTheme } from '../../src/tui/theme.js';
import type { SessionSummary } from '../../src/products/contract.js';

test('session catalog distinguishes missing transcripts from unreadable files in both locales', () => {
  const base: SessionSummary = {
    productId: 'claude-code', sessionId: 'history-a', sourcePath: 'history.jsonl#reprise-history=history-a', cwd: 'C:/work',
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
    availability: 'catalog-only', evidenceLevel: 'history', recoveryReadiness: 'history-only',
  };
  const sessions = [base, { ...base, sessionId: 'history-b' }, { ...base, sessionId: 'broken', availability: 'unreadable' as const }];
  for (const locale of ['en', 'zh'] as const) {
    const output = renderSessions(createTheme(140, false), 140, {
      level: 'projects', projects: groupSessionsByProject(sessions), sessions, selected: 0,
      filterEligible: false, query: '', searching: false, locale,
    }, 30).join('\n');
    assert.match(output, locale === 'en' ? /2 index-only records; full transcripts not found/ : /2 条仅有历史索引，未找到完整正文/);
    assert.match(output, locale === 'en' ? /1 records could not be read/ : /1 条记录无法读取/);
    assert.doesNotMatch(output, locale === 'en' ? /3 records could not be read/ : /3 条记录无法读取/);
  }
});
