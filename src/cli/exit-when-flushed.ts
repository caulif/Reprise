import { once } from "node:events";

/** Exit only after stdout and stderr have accepted the result already written. */
export async function exitWhenFlushed(code: number): Promise<never> {
  await flushWritable(process.stdout);
  await flushWritable(process.stderr);
  process.exit(code);
}

async function flushWritable(stream: NodeJS.WriteStream): Promise<void> {
  if (!stream.writable || stream.destroyed || stream.writableEnded) return;
  await new Promise<void>((resolve) => {
    const ok = stream.write("", () => resolve());
    if (!ok) stream.once("drain", () => resolve());
  });
  if (stream.writableNeedDrain) await once(stream, "drain");
}
