import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { ComparisonFindingsDeltaSchema, type ComparisonFindingsDelta } from '../src/core/schema.js';

export function retainComparisonFindings(prompt: string): ComparisonFindingsDelta {
  const state = JSON.parse(prompt.split('Current saved findings (hypotheses only): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as {
    binding: ComparisonFindingsDelta['binding']; findingIds: string[]; questionIds: string[];
  };
  const delta: ComparisonFindingsDelta = { kind: 'delta', binding: state.binding,
    findingDecisions: state.findingIds.map(id => ({ id, action: 'retain' })),
    questionDecisions: state.questionIds.map(id => ({ id, action: 'retain' })) };
  assert.ok(Value.Check(ComparisonFindingsDeltaSchema, delta));
  return delta;
}
