import { open } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import { extractContent, ExtractedContentSchema, type ExtractedContent } from "./content-extraction.js";

const [source, output, format] = process.argv.slice(2);
if (!source || !output || !format) throw new Error("Extraction worker requires source, output, and format.");
const sourceHandle = await open(source, "r");
let bytes: Buffer;
try {
  const metadata = await sourceHandle.stat();
  if (!metadata.isFile() || metadata.size > 8_388_608) throw new Error("Extraction source is not a regular file under 8 MiB.");
  const buffer = Buffer.alloc(8_388_609);
  let read = 0;
  while (read < buffer.byteLength) {
    const next = await sourceHandle.read(buffer, read, buffer.byteLength - read, read);
    if (!next.bytesRead) break;
    read += next.bytesRead;
  }
  if (read > 8_388_608) throw new Error("Extraction source changed or exceeds 8 MiB.");
  bytes = buffer.subarray(0, read);
} finally { await sourceHandle.close(); }
const extracted = await extractContent(bytes, format as ExtractedContent["format"]);
if (!Value.Check(ExtractedContentSchema, extracted)) throw new Error("Extracted content failed schema validation.");
await writeAtomic(output, `${JSON.stringify(extracted, null, 2)}\n`);
process.stdout.write(JSON.stringify({ ok: true, format, fragments: extracted.fragments.length,
  limitations: extracted.limitations }));
