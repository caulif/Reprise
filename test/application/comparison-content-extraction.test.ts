import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContent } from "../../src/infrastructure/content-extraction.js";
import { ExtractedContentSchema } from "../../src/infrastructure/content-extraction.js";
import { Value } from "@sinclair/typebox/value";
import { runExtractCli } from "../../src/cli/extract.js";

test("CSV and JSON extraction preserve cell and pointer locations", async () => {
  const csv = await extractContent(Buffer.from('name,value\n"multi\nline",\n'), "csv");
  assert.deepEqual(csv.fragments.slice(2), [
    { location: "row 2, column 1", text: "multi\nline" },
    { location: "row 2, column 2", text: "" },
  ]);
  const json = await extractContent(Buffer.from('{"a/b":[null,3]}'), "json");
  assert.deepEqual(json.fragments, [
    { location: "/a~1b/0", text: "null" },
    { location: "/a~1b/1", text: "3" },
  ]);
});

test("Office extraction returns document, slide, and stored cell positions", async () => {
  const docx = new JSZip();
  docx.file("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:body></w:document>');
  assert.deepEqual((await extractContent(await docx.generateAsync({ type: "nodebuffer" }), "docx")).fragments,
    [{ location: "paragraph 1", text: "Alpha" }]);

  const pptx = new JSZip();
  pptx.file("ppt/slides/slide1.xml", '<p:sld><a:p><a:r><a:t>Slide</a:t></a:r></a:p></p:sld>');
  assert.deepEqual((await extractContent(await pptx.generateAsync({ type: "nodebuffer" }), "pptx")).fragments,
    [{ location: "ppt/slides/slide1.xml, paragraph 1", text: "Slide" }]);

  const xlsx = new JSZip();
  xlsx.file("xl/sharedStrings.xml", '<sst><si><t>Revenue</t></si></sst>');
  xlsx.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
  assert.deepEqual((await extractContent(await xlsx.generateAsync({ type: "nodebuffer" }), "xlsx")).fragments,
    [{ location: "xl/worksheets/sheet1.xml, cell A1", text: "Revenue" }, { location: "xl/worksheets/sheet1.xml, cell B1", text: "42" }]);
});

test("content extraction rejects malformed or oversized input", async () => {
  await assert.rejects(extractContent(Buffer.from("broken"), "docx"));
  await assert.rejects(extractContent(Buffer.alloc(8_388_609), "csv"), /8 MiB/);
});

test("PDF extraction identifies page text", async () => {
  const extracted = await extractContent(await readFile(new URL("../fixtures/comparison-simple.pdf", import.meta.url)), "pdf");
  assert.ok(extracted.fragments.some((fragment) => fragment.location.startsWith("page 1,") && fragment.text.includes("Hello PDF")));
});

test("PDF extraction rejects corrupt PDF", async () => {
  await assert.rejects(extractContent(Buffer.from("%PDF-1.4\ninvalid"), "pdf"));
});

test("CLI extraction writes a reusable structured result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-extract-cli-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "sample.csv");
  const output = join(root, "extracted.json");
  await writeFile(source, "name,value\nitem,7\n");
  const messages: string[] = [];
  assert.equal(await runExtractCli([source, "--output", output], {
    stdout: (message) => messages.push(message), stderr: (message) => messages.push(message),
  }), 0);
  assert.match(messages[0] ?? "", /"fragments":4/);
  const parsed: unknown = JSON.parse(await readFile(output, "utf8"));
  assert.ok(Value.Check(ExtractedContentSchema, parsed));
  assert.deepEqual(parsed.fragments[3],
    { location: "row 2, column 2", text: "7" });
  await assert.rejects(runExtractCli([source, "--output", source], {
    stdout: () => undefined, stderr: () => undefined,
  }), /overwrite/);
  assert.equal(await readFile(source, "utf8"), "name,value\nitem,7\n");
});
