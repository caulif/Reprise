import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/test/fixtures', { recursive: true });
await copyFile('test/fixtures/codex-session.fixture.json', 'dist/test/fixtures/codex-session.fixture.json');
