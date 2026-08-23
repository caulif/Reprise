import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROLLER_SYSTEM_PROMPT } from '../src/agents/controller-agent.js';
import { COMPARISON_SYSTEM_PROMPT } from '../src/agents/comparison-agent.js';
import { RECOVERY_SYSTEM_PROMPT } from '../src/agents/recovery-agent.js';
import { comparisonReportTool, observationTools } from '../src/infrastructure/agent-tools.js';
import { recoveryObservationTools, recoveryTools } from '../src/infrastructure/recovery-tools.js';
import type { TaskCase } from '../src/core/schema.js';
import type { ExperimentStore } from '../src/infrastructure/store/experiment-store.js';

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../test/snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

async function assertSnapshot(name: string, actual: string): Promise<void> {
  const path = join(SNAPSHOT_DIR, `${name}.txt`);
  const normalized = actual.replace(/\r\n/g, '\n');
  if (UPDATE) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, normalized, 'utf8');
    return;
  }
  const expected = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(normalized, expected, `snapshot ${name} drifted; set UPDATE_SNAPSHOTS=1 to rewrite`);
}

function toolCatalog(tools: readonly { name: string; description: string; parameters: unknown }[]): string {
  return `${JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })), null, 2)}\n`;
}

test('agent system prompts match committed snapshots', async () => {
  await assertSnapshot('controller-system-prompt', `${CONTROLLER_SYSTEM_PROMPT}\n`);
  await assertSnapshot('comparison-system-prompt', `${COMPARISON_SYSTEM_PROMPT}\n`);
  await assertSnapshot('recovery-system-prompt', `${RECOVERY_SYSTEM_PROMPT}\n`);
});

test('runtime-facing tool schemas match committed snapshots', async () => {
  const store = { events: () => [] } as unknown as ExperimentStore;
  const transcript: TaskCase['transcript'] = [{ id: 'message-1', role: 'user', text: 'Add a deterministic fixture importer.' }];
  const taskCase = {
    transcript,
    historicalEvents: [],
  } as unknown as TaskCase;
  await assertSnapshot('observation-tools', toolCatalog(observationTools(store, {
    runId: 'run-1',
    transcript,
    allowModelText: true,
  })));
  await assertSnapshot('comparison-report-tool', toolCatalog([comparisonReportTool('TMP')]));
  await assertSnapshot('recovery-observation-tools', toolCatalog(recoveryObservationTools(taskCase)));
  await assertSnapshot('recovery-tools', toolCatalog(recoveryTools('TMP', 8)));
});
