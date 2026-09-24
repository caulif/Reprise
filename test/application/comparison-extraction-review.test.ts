import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractContent } from "../../src/infrastructure/content-extraction.js";

function archive(kind: "docx" | "xlsx"): JSZip {
  const zip = new JSZip();
  const target = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
  const type = kind === "docx" ? "wordprocessingml.document" : "spreadsheetml.sheet";
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${target}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`);
  if (kind === "xlsx") {
    zip.file("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
  }
  return zip;
}

test("document extraction preserves identifiers, run spaces, and XML text entities", async () => {
  const zip = archive("docx");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>00123</w:t></w:r></w:p>
      <w:p/>
      <w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:r><w:t>beta</w:t></w:r></w:p>
      <w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p>
    </w:body></w:document>`);
  const extracted = await extractContent(await zip.generateAsync({ type: "nodebuffer" }), "docx");
  assert.deepEqual(extracted.fragments.map((item) => item.text), ["00123", "Alpha beta", "A & B"]);
  assert.ok(extracted.limitations.some((item) => /visual|render|appearance/i.test(item)));
});

test("malformed document XML is not silently accepted as an empty successful extraction", async () => {
  const zip = archive("docx");
  zip.file("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>truncated');
  await assert.rejects(extractContent(await zip.generateAsync({ type: "nodebuffer" }), "docx"), /XML|malformed|invalid|corrupt/i);
});

test("workbook extraction keeps numeric-looking shared strings and rich inline text", async () => {
  const zip = archive("xlsx");
  zip.file("xl/sharedStrings.xml", '<sst><si><t>00123</t></si></sst>');
  zip.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><t xml:space="preserve">Alpha </t></r><r><t>beta</t></r></is></c></row></sheetData></worksheet>');
  const extracted = await extractContent(await zip.generateAsync({ type: "nodebuffer" }), "xlsx");
  assert.deepEqual(extracted.fragments.map((item) => item.text), ["00123", "Alpha beta"]);
  assert.ok(extracted.limitations.some((item) => /not recalculated/i.test(item)));
});

test("JSON extraction distinguishes empty containers from missing fields", async () => {
  const extracted = await extractContent(Buffer.from('{"items":[],"metadata":{}}'), "json");
  assert.deepEqual(extracted.fragments, [
    { location: "/items", text: "[]" },
    { location: "/metadata", text: "{}" },
  ]);
});

test("document text retains source order around ordinary hyperlinks", async () => {
  const zip = archive("docx");
  zip.file("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>Alpha </w:t></w:r><w:hyperlink><w:r><w:t>linked </w:t></w:r></w:hyperlink><w:r><w:t>Beta</w:t></w:r></w:p></w:body></w:document>');
  const extracted = await extractContent(await zip.generateAsync({ type: "nodebuffer" }), "docx");
  assert.equal(extracted.fragments[0]?.text, "Alpha linked Beta");
});

test("Office parsing refuses custom entities and bounded expansion ignores dishonest ZIP sizes", async () => {
  const entities = archive("docx");
  entities.file("word/document.xml", '<!DOCTYPE root [<!ENTITY private "expanded">]><root><w:p><w:t>&private;</w:t></w:p></root>');
  await assert.rejects(extractContent(await entities.generateAsync({ type: "nodebuffer" }), "docx"), /entities/);

  const compressed = new JSZip();
  compressed.file("word/document.xml", "A".repeat(8_388_609), { createFolders: false });
  const bytes = await compressed.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(directory >= 0);
  bytes.writeUInt32LE(1, directory + 24);
  bytes.writeUInt32LE(1, 22);
  await assert.rejects(extractContent(bytes, "docx"), /expansion limit/);
});
