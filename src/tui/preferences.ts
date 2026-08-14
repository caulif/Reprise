import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../core/json.js';
import { writeAtomic } from '../core/identity.js';
import { parseLocale, type Locale } from './i18n.js';

const FILE_NAME = 'tui-preferences.json';

export type TuiPreferences = {
  readonly locale: Locale;
};

export function defaultTuiPreferences(): TuiPreferences {
  return { locale: 'en' };
}

export async function readTuiPreferences(dataDir: string): Promise<TuiPreferences> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, FILE_NAME), 'utf8')) as unknown;
    if (!isRecord(value)) return defaultTuiPreferences();
    return { locale: parseLocale(typeof value.locale === 'string' ? value.locale : undefined) ?? 'en' };
  } catch (error) {
    if (isMissing(error)) return defaultTuiPreferences();
    return defaultTuiPreferences();
  }
}

export async function saveTuiPreferences(dataDir: string, preferences: TuiPreferences): Promise<void> {
  await writeAtomic(join(dataDir, FILE_NAME), `${JSON.stringify({ locale: preferences.locale }, null, 2)}\n`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
