import { readFileSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { CliPackageMetadataSchema } from '../core/schema.js';

export function readCliPackageVersion(path = new URL('../../../package.json', import.meta.url)): string {
  const metadata: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Value.Check(CliPackageMetadataSchema, metadata)) throw new Error('Invalid installed Reprise package metadata.');
  return metadata.version;
}
