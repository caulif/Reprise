import { createServer } from "node:net";
import { exitWhenFlushed } from "../../src/cli/exit-when-flushed.js";

const server = createServer();
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
const body = JSON.stringify({
  ok: false,
  command: "compare",
  data: { status: "failed", reportPath: "comparison-failure.html" },
});
await new Promise<void>((resolve, reject) => {
  process.stdout.write(`${body}\n`, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
await exitWhenFlushed(1);
