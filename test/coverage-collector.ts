import { constants } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Run as a test file so Node's own coverage collector merges the transported V8 reports.
const input = process.env.REPRISE_COVERAGE_INPUT;
const output = process.env.NODE_V8_COVERAGE;
if (!input || !output) throw new Error('Coverage collector requires validated input and an active Node coverage directory.');
for (const name of await readdir(input)) {
  await copyFile(join(input, name), join(output, name), constants.COPYFILE_EXCL);
}
