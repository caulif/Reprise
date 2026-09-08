import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/test/fixtures", { recursive: true });
await copyFile(
  "test/fixtures/codex-session.fixture.json",
  "dist/test/fixtures/codex-session.fixture.json",
);

await copyFile(
  "test/fixtures/recovery-truth-dataset.json",
  "dist/test/fixtures/recovery-truth-dataset.json",
);

await mkdir("dist/src/products/codex/recovery", { recursive: true });
await copyFile(
  "src/products/codex/recovery/SKILL.md",
  "dist/src/products/codex/recovery/SKILL.md",
);

await mkdir("dist/src/products/claude-code/recovery", { recursive: true });
await copyFile(
  "src/products/claude-code/recovery/SKILL.md",
  "dist/src/products/claude-code/recovery/SKILL.md",
);

await mkdir("dist/test/fixtures/fake-pack/sessions", { recursive: true });
await copyFile(
  "test/fixtures/fake-pack/sessions/sample.jsonl",
  "dist/test/fixtures/fake-pack/sessions/sample.jsonl",
);
await copyFile(
  "test/fixtures/fake-pack/package.json",
  "dist/test/fixtures/fake-pack/package.json",
);
