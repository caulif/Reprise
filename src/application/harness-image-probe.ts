import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { HarnessImageProbeSchema } from '../core/schemas/image-probe.js';
import { writeAtomic } from '../core/identity.js';
import { readHarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { PiModelCaller } from '../infrastructure/agent/model-caller.js';
import { CliError } from './cli-error.js';

export async function probeHarnessImageInput(dataDir: string) {
  if (process.env.REPRISE_RUN_IMAGE_PROBE !== '1') throw new CliError('usage', 'Image probe can incur costs. Set REPRISE_RUN_IMAGE_PROBE=1 to opt in.');
  const config = await readHarnessModelConfig(dataDir);
  if (!config) throw new CliError('config_missing', 'Configure the internal model before an image probe.');
  const result = await new PiModelCaller(config).probeImageInput();
  if (!Value.Check(HarnessImageProbeSchema, result)) throw new Error('Image probe result failed schema validation.');
  await writeAtomic(join(dataDir, 'harness-image-probe.json'), JSON.stringify(result));
  return result;
}

export async function readImageProbe(dataDir: string) {
  let raw: string;
  try { raw = await readFile(join(dataDir, 'harness-image-probe.json'), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'not_tested' }; throw error; }
  const result: unknown = JSON.parse(raw);
  if (!Value.Check(HarnessImageProbeSchema, result)) throw new Error('Stored image probe result failed schema validation.');
  const config = await readHarnessModelConfig(dataDir);
  if (!config) return { status: 'stale', observedAt: result.observedAt };
  const snapshot = new PiModelCaller(config).modelSnapshot;
  return result.configFingerprint === snapshot.configFingerprint ? result : { status: 'stale', observedAt: result.observedAt };
}
