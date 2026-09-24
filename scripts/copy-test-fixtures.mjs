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
await copyFile(
  "test/fixtures/comparison-simple.pdf",
  "dist/test/fixtures/comparison-simple.pdf",
);

await mkdir("dist/src/products/packs/codex/recovery", { recursive: true });
await copyFile(
  "src/products/packs/codex/recovery/SKILL.md",
  "dist/src/products/packs/codex/recovery/SKILL.md",
);

await mkdir("dist/src/products/packs/claude-code/recovery", { recursive: true });
await copyFile(
  "src/products/packs/claude-code/recovery/SKILL.md",
  "dist/src/products/packs/claude-code/recovery/SKILL.md",
);
await copyFile(
  "src/products/packs/claude-code/README.md",
  "dist/src/products/packs/claude-code/README.md",
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

await mkdir("dist/test/fixtures/historical-svg-animation", { recursive: true });
await copyFile(
  "test/fixtures/historical-svg-animation/animation.html",
  "dist/test/fixtures/historical-svg-animation/animation.html",
);
await copyFile(
  "test/fixtures/historical-svg-animation/candidate-animation.html",
  "dist/test/fixtures/historical-svg-animation/candidate-animation.html",
);
