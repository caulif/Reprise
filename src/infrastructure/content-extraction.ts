import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import PDFParser from "pdf2json";

const MAX_INPUT_BYTES = 8_388_608;
const MAX_TEXT_BYTES = 8_388_608;
const JsonValueSchema = Type.Recursive((self) => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(self),
  Type.Record(Type.String(), self),
]));

export type ExtractedContent = {
  format: "csv" | "json" | "pdf" | "docx" | "xlsx" | "pptx";
  fragments: { location: string; text: string }[];
  limitations: string[];
};

export const ExtractedContentSchema = Type.Object({
  format: Type.Union([Type.Literal("csv"), Type.Literal("json"), Type.Literal("pdf"),
    Type.Literal("docx"), Type.Literal("xlsx"), Type.Literal("pptx")]),
  fragments: Type.Array(Type.Object({ location: Type.String(), text: Type.String() })),
  limitations: Type.Array(Type.String()),
});

export async function extractContent(bytes: Buffer, format: ExtractedContent["format"]): Promise<ExtractedContent> {
  if (!bytes.length || bytes.byteLength > MAX_INPUT_BYTES) throw new Error("Extraction input is empty or exceeds 8 MiB.");
  if (format === "csv") return extractCsv(bytes);
  if (format === "json") return extractJson(bytes);
  if (format === "pdf") return extractPdf(bytes);
  return extractOffice(bytes, format);
}

function decoded(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("Extracted text exceeds 8 MiB.");
  return text.replace(/^\uFEFF/, "");
}

function extractCsv(bytes: Buffer): ExtractedContent {
  const records: string[][] = parseCsv(decoded(bytes), { bom: true, relax_quotes: false,
    skip_empty_lines: false, max_record_size: 1_048_576 });
  if (records.length > 10_000 || records.some((row) => row.length > 512)) throw new Error("CSV row or column limit exceeded.");
  return { format: "csv", fragments: records.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    location: `row ${rowIndex + 1}, column ${columnIndex + 1}`, text,
  }))), limitations: ["CSV values are text; formulas are not evaluated."] };
}

function extractJson(bytes: Buffer): ExtractedContent {
  const value: unknown = JSON.parse(decoded(bytes));
  if (!Value.Check(JsonValueSchema, value)) throw new Error("JSON document has unsupported values.");
  const fragments: ExtractedContent["fragments"] = [];
  const visit = (item: unknown, path: string, depth: number) => {
    if (depth > 32 || fragments.length > 10_000) throw new Error("JSON nesting or entry limit exceeded.");
    if (Array.isArray(item)) {
      if (!item.length) fragments.push({ location: path || "/", text: "[]" });
      else item.forEach((child, index) => visit(child, `${path}/${index}`, depth + 1));
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item);
      if (!entries.length) fragments.push({ location: path || "/", text: "{}" });
      else entries.forEach(([key, child]) => visit(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1));
    }
    else fragments.push({ location: path || "/", text: JSON.stringify(item) });
  };
  visit(value, "", 0);
  return { format: "json", fragments, limitations: [] };
}

async function extractPdf(bytes: Buffer): Promise<ExtractedContent> {
  const parser = new PDFParser(null, false);
  try {
    const data = await new Promise<{ Pages: { Texts: { x: number; y: number; R: { T: string }[] }[] }[] }>((resolve, reject) => {
      parser.once("pdfParser_dataReady", resolve);
      parser.once("pdfParser_dataError", (error: unknown) => {
        const nested = error && typeof error === "object" && "parserError" in error ? error.parserError : error;
        reject(nested instanceof Error ? nested : new Error(String(nested)));
      });
      parser.parseBuffer(bytes);
    });
    if (data.Pages.length > 500) throw new Error("PDF page limit exceeded.");
    const fragments = data.Pages.flatMap((page, pageIndex) => page.Texts.map((text) => ({
      location: `page ${pageIndex + 1}, x=${text.x}, y=${text.y}`,
      text: text.R.map((run) => decodeURIComponent(run.T)).join(""),
    })));
    if (Buffer.byteLength(JSON.stringify(fragments)) > MAX_TEXT_BYTES) throw new Error("PDF extracted text exceeds 8 MiB.");
    return { format: "pdf", fragments, limitations: ["Text layer only; scanned images, layout, and visual appearance are not verified."] };
  } finally { parser.destroy(); }
}

async function extractOffice(bytes: Buffer, format: "docx" | "xlsx" | "pptx"): Promise<ExtractedContent> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  const names = Object.keys(zip.files);
  if (names.length > 2000) throw new Error("Office package entry limit exceeded.");
  let announcedTotal = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const announced = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (!Number.isSafeInteger(announced) || announced! < 0 || announced! > MAX_TEXT_BYTES - announcedTotal) {
      throw new Error("Office package expansion limit exceeded.");
    }
    announcedTotal += announced!;
  }
  let expanded = 0;
  const xml = async (name: string, preserveOrder = false): Promise<unknown> => {
    const file = zip.file(name);
    if (!file) return undefined;
    const announced = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (!Number.isSafeInteger(announced) || announced! > MAX_TEXT_BYTES - expanded) throw new Error("Office package expansion limit exceeded.");
    const content = await new Promise<Buffer>((resolve, reject) => {
      const stream = file.nodeStream();
      const chunks: Buffer[] = [];
      let settled = false;
      stream.on("data", (raw: Buffer | Uint8Array) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (chunk.byteLength > MAX_TEXT_BYTES - expanded) {
          settled = true;
          (stream as typeof stream & { destroy(): void }).destroy();
          reject(new Error("Office package expansion limit exceeded."));
          return;
        }
        expanded += chunk.byteLength;
        chunks.push(chunk);
      });
      stream.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
      stream.on("error", (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error(String(error))); } });
    });
    const source = decoded(content);
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("Office package custom XML entities are not allowed.");
    if (XMLValidator.validate(source) !== true) throw new Error("Office package contains invalid XML.");
    return new XMLParser({ ignoreAttributes: false, textNodeName: "#text", trimValues: false, preserveOrder,
      parseTagValue: false, parseAttributeValue: false, processEntities: true }).parse(source);
  };
  const fragments: ExtractedContent["fragments"] = [];
  if (format === "docx") {
    if (!zip.file("word/document.xml")) throw new Error("Office document body is missing.");
    const body = await xml("word/document.xml", true);
    let paragraph = 0;
    collectOrderedText(body, "w:p", "w:t", (text) => { paragraph += 1; if (text) fragments.push({ location: `paragraph ${paragraph}`, text }); });
    return { format, fragments, limitations: ["Main document text only; headers, footers, comments, and rendered pages are not verified."] };
  }
  if (format === "pptx") {
    const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
    if (!slides.length) throw new Error("Presentation slides are missing.");
    for (const name of slides) {
      const slide = await xml(name, true);
      let paragraph = 0;
      collectOrderedText(slide, "a:p", "a:t", (text) => { paragraph += 1; if (text) fragments.push({ location: `${name}, paragraph ${paragraph}`, text }); });
    }
    return { format, fragments, limitations: ["Part paths are source locations, not display order; speaker notes, animations, and appearance are not verified."] };
  }
  const shared: string[] = [];
  const sharedXml = await xml("xl/sharedStrings.xml", true);
  collectOrderedText(sharedXml, "si", "t", (text) => shared.push(text));
  const sheets = names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  if (!sheets.length) throw new Error("Workbook sheets are missing.");
  for (const name of sheets) {
    const sheet = await xml(name);
    walk(sheet, "c", (cell) => {
      if (!cell || typeof cell !== "object") return;
      const value = cell as Record<string, unknown>;
      const ref = typeof value["@_r"] === "string" ? value["@_r"] : "unknown";
      const raw = value["@_t"] === "inlineStr" ? nestedText(value.is, "t") : nodeText(value.v);
      const formula = nodeText(value.f);
      if (!raw && !formula) return;
      const text = value["@_t"] === "s" ? shared[Number(raw)] ?? "" : value["@_t"] === "b"
        ? (raw === "1" ? "true" : raw === "0" ? "false" : `invalid boolean: ${raw}`) : raw;
      fragments.push({ location: `${name}, cell ${ref}`, text: formula && !raw ? `[formula result unavailable: ${formula}]` : text });
    });
  }
  return { format, fragments, limitations: ["Part paths do not establish sheet names or tab order. Stored cell values only; formulas are not recalculated, and charts or visual layout are not verified."] };
}

function collectOrderedText(node: unknown, container: string, leaf: string, add: (text: string) => void): void {
  if (Array.isArray(node)) { node.forEach((item) => collectOrderedText(item, container, leaf, add)); return; }
  if (!node || typeof node !== "object") return;
  for (const [name, value] of Object.entries(node)) {
    if (name === container) add(orderedText(value, leaf));
    else collectOrderedText(value, container, leaf, add);
  }
}

function orderedText(node: unknown, leaf: string): string {
  if (Array.isArray(node)) return node.map((item) => orderedText(item, leaf)).join("");
  if (!node || typeof node !== "object") return "";
  return Object.entries(node).map(([name, value]) =>
    name === leaf ? orderedLeafText(value) : orderedText(value, leaf)).join("");
}

function orderedLeafText(node: unknown): string {
  if (Array.isArray(node)) return node.map(orderedLeafText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return Object.entries(node).map(([name, value]) => name === "#text" ? nodeText(value) : orderedLeafText(value)).join("");
}

function nestedText(node: unknown, leaf: string): string {
  const chunks: string[] = [];
  walk(node, leaf, (value) => chunks.push(nodeText(value)));
  return chunks.join("");
}

function walk(node: unknown, key: string, visit: (value: unknown) => void): void {
  if (Array.isArray(node)) { node.forEach((item) => walk(item, key, visit)); return; }
  if (!node || typeof node !== "object") return;
  for (const [name, value] of Object.entries(node)) {
    if (name === key) (Array.isArray(value) ? value : [value]).forEach(visit);
    else walk(value, key, visit);
  }
}

function nodeText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["#text"] !== undefined) return nodeText(record["#text"]);
    if (record.t !== undefined) return nodeText(record.t);
  }
  return "";
}
