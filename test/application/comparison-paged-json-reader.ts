import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { workspaceTools } from '../../src/infrastructure/recovery-workspace-tools.js';

export async function readComparisonJsonPages(root: string, path: string): Promise<string> {
  const read = workspaceTools(root).find(tool => tool.name === 'read');
  assert.ok(read);
  let offset = 0;
  let joined = '';
  let pages = 0;
  for (;;) {
    const page = await read.execute({ path, offset, maxBytes: 4096 }, new AbortController().signal);
    assert.doesNotMatch(page.content, /[\u0080-\uffff]/);
    const details: unknown = page.details;
    assert.ok(Value.Check(Type.Object({ available: Type.Literal(true), truncated: Type.Boolean(), nextCursor: Type.Optional(Type.Integer({ minimum: 1 })) }), details));
    joined += page.content;
    pages++;
    if (!details.truncated) break;
    assert.ok(details.nextCursor && details.nextCursor > offset);
    offset = details.nextCursor;
  }
  assert.ok(pages > 1, 'must exercise an actual byte-page boundary');
  return joined;
}
