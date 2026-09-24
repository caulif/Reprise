import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnhanceCli } from "../../src/cli/enhance.js";
import { detectToolCapabilities, saveToolConfig } from "../../src/infrastructure/tool-capabilities.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function fakeExecutable(root: string): Promise<string> {
  const script = join(root, "fake-tool.cjs");
  await writeFile(script, `const fs = require('node:fs');
const args = process.argv.slice(2);
if ((args.includes('-show_streams') || args.includes('-frames:v')) &&
    (!args.includes('-protocol_whitelist') || !args.includes('-enable_drefs') || args[args.indexOf('-enable_drefs') + 1] !== '0')) process.exit(4);
if (args.includes('-version') || args.includes('--version')) console.log('fake tool 1.0');
else if (args.includes('-show_streams')) console.log(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }], format: { duration: '1.5' } }));
else if (args.includes('-frames:v')) fs.writeFileSync(args.at(-1), Buffer.from('${PNG.toString("base64")}', 'base64'));
else if (args.at(-1) === 'stdout') process.stdout.write('Recognized words\\n');
else process.exit(3);
`);
  const executable = join(root, process.platform === "win32" ? "fake-tool.cmd" : "fake-tool.sh");
  await writeFile(executable, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  return executable;
}

test("configured ffprobe, ffmpeg, and OCR execute through bounded CLI wrappers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-enhancement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const executable = await fakeExecutable(root);
  const config = { schemaVersion: 1 as const, enhancements: {
    ffprobePath: executable, ffmpegPath: executable, tesseractPath: executable, libreOfficePath: executable,
  } };
  await saveToolConfig(dataDir, config);
  const source = join(root, "sample media.mp4");
  await writeFile(source, Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]));
  const output: string[] = [];
  const io = { stdout: (value: string) => output.push(value), stderr: (value: string) => output.push(value) };
  const probe = join(root, "probe.json");
  assert.equal(await runEnhanceCli(["inspect-media", source, "--output", probe, "--data-dir", dataDir], io), 0);
  const media = JSON.parse(await readFile(probe, "utf8")) as { sourceName: string; streams: { codec: string }[] };
  assert.equal(media.sourceName, "sample media.mp4");
  assert.equal(media.streams[0]?.codec, "h264");
  const frame = join(root, "frame.png");
  assert.equal(await runEnhanceCli(["extract-frame", source, "--output", frame, "--time-ms", "500", "--data-dir", dataDir], io), 0);
  assert.deepEqual(await readFile(frame), PNG);
  const transcript = join(root, "ocr.txt");
  assert.equal(await runEnhanceCli(["ocr-text", frame, "--output", transcript, "--data-dir", dataDir], io), 0);
  assert.equal(await readFile(transcript, "utf8"), "Recognized words\n");
  assert.ok(output.every((line) => !line.includes(root)));
  const { manifest } = await detectToolCapabilities(config);
  assert.deepEqual(manifest.optional.find((item) => item.id === "ffprobe")?.operations, ["inspect_media"]);
  assert.deepEqual(manifest.optional.find((item) => item.id === "ffmpeg")?.operations, ["extract_frame"]);
  assert.deepEqual(manifest.optional.find((item) => item.id === "tesseract")?.operations, ["ocr_text"]);
  assert.deepEqual(manifest.optional.find((item) => item.id === "libreoffice")?.operations, []);
  assert.match(manifest.optional.find((item) => item.id === "libreoffice")?.reason ?? "", /unsupported/);
});

test("enhancement CLI rejects source overwrite and invalid frame times", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-enhancement-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const executable = await fakeExecutable(root);
  await saveToolConfig(dataDir, { schemaVersion: 1, enhancements: { ffprobePath: executable, ffmpegPath: executable, tesseractPath: executable } });
  const source = join(root, "input.mp4");
  await writeFile(source, Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]));
  const io = { stdout() {}, stderr() {} };
  await assert.rejects(runEnhanceCli(["inspect-media", source, "--output", source, "--data-dir", dataDir], io), /overwrite its source/);
  await assert.rejects(runEnhanceCli(["extract-frame", source, "--output", join(root, "frame.png"), "--time-ms", "-1", "--data-dir", dataDir], io), /time-ms/);
  const playlist = join(root, "remote.m3u8");
  await writeFile(playlist, "#EXTM3U\nhttps://external.example/video.ts\n");
  await assert.rejects(runEnhanceCli(["inspect-media", playlist, "--output", join(root, "probe.json"), "--data-dir", dataDir], io), /supported local media container/);
  const disguised = join(root, "disguised.mp4");
  await writeFile(disguised, "#EXTM3U\nfile:///private/video.ts\n");
  await assert.rejects(runEnhanceCli(["extract-frame", disguised, "--output", join(root, "frame.png"), "--time-ms", "0", "--data-dir", dataDir], io), /supported local media container/);
  await assert.rejects(runEnhanceCli(["ocr-text", playlist, "--output", join(root, "ocr.txt"), "--data-dir", dataDir], io), /PNG, JPEG, or TIFF/);
});
