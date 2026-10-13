import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../../core/identity.js";
import type { TaskCase } from "../../core/schema.js";

/** A lossless text projection of the already frozen, privacy-processed transcript. */
export async function writeObservationNavigation(root: string, taskCase: TaskCase, catalogRows: readonly string[]): Promise<number> {
  await mkdir(join(root, "timeline"), { recursive: true });
  await mkdir(join(root, "index-pages"), { recursive: true });
  const rows = ["order\trole\tref\tpath\toriginal\tpreview"];
  for (const [index, message] of taskCase.transcript.entries()) {
    const name = String(index + 1).padStart(6, "0");
    const original = `observations/transcript/${message.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    const path = `observations/timeline/${name}.txt`;
    rows.push(`${index + 1}\t${message.role}\t${message.id}\t${path}\t${original}\t${message.text.replace(/\s+/g, " ").slice(0, 120)}`);
    await writeAtomic(join(root, "timeline", `${name}.txt`), `order: ${index + 1}\nrole: ${message.role}\nref: ${message.id}\noriginal: ${original}\n\n${message.text}\n`);
  }
  await writeAtomic(join(root, "timeline", "INDEX.tsv"), `${rows.join("\n")}\n`);
  let pageCount = 0;
  for (let offset = 1; offset < catalogRows.length; offset += 100) {
    pageCount++;
    await writeAtomic(join(root, "index-pages", `${String(pageCount).padStart(4, "0")}.tsv`), `${[catalogRows[0], ...catalogRows.slice(offset, offset + 100)].join("\n")}\n`);
  }
  return taskCase.transcript.length + 1 + pageCount;
}
