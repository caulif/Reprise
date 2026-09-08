import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  CONTROL_CLIENT_TIMEOUT_MS,
  CONTROL_MAX_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlRequestSchema,
  ControlResponseSchema,
  type ControlEndpoint,
  type ControlRequest,
  type ControlResponse,
} from "../core/control-protocol.js";

export function controlIpcDir(dataDir: string, ownerInstanceId: string): string {
  return join(dataDir, "ipc", ownerInstanceId);
}

export function controlEndpointFor(
  ownerInstanceId: string,
  ipcDir: string,
  platform: NodeJS.Platform = process.platform,
): ControlEndpoint {
  if (platform === "win32") return { kind: "pipe", name: `\\\\.\\pipe\\reprise-${ownerInstanceId}` };
  return { kind: "unix", path: join(ipcDir, "sock") };
}

export async function listenControlEndpoint(input: {
  readonly ipcDir: string;
  readonly endpoint: ControlEndpoint;
  readonly onRequest: (request: ControlRequest) => Promise<ControlResponse>;
}): Promise<{ close: () => Promise<void> }> {
  await mkdir(input.ipcDir, { recursive: true });
  await chmodQuiet(input.ipcDir, 0o700);
  if (input.endpoint.kind === "unix") {
    await unlink(input.endpoint.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const server = createServer((socket) => {
    void serveSocket(socket, input.onRequest);
  });
  await bindEndpoint(server, input.endpoint);
  server.unref();
  if (input.endpoint.kind === "unix") await chmodQuiet(input.endpoint.path, 0o700);
  return {
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

export async function sendControlRequest(
  endpoint: ControlEndpoint,
  request: ControlRequest,
  timeoutMs = CONTROL_CLIENT_TIMEOUT_MS,
): Promise<ControlResponse | { status: "unreachable" } | { status: "timeout" }> {
  const socket = connectEndpoint(endpoint);
  try {
    const payload = await Promise.race([
      writeAndRead(socket, request),
      sleepStatus(timeoutMs, socket),
    ]);
    return payload;
  } catch {
    return { status: "unreachable" };
  } finally {
    socket.destroy();
  }
}

function bindEndpoint(server: Server, endpoint: ControlEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (endpoint.kind === "pipe") server.listen(endpoint.name, () => resolve());
    else server.listen(endpoint.path, () => resolve());
  });
}

function connectEndpoint(endpoint: ControlEndpoint): Socket {
  return endpoint.kind === "pipe" ? createConnection(endpoint.name) : createConnection(endpoint.path);
}

async function serveSocket(socket: Socket, onRequest: (request: ControlRequest) => Promise<ControlResponse>): Promise<void> {
  try {
    const raw = await readLimitedJson(socket, CONTROL_MAX_BYTES);
    if (!Value.Check(ControlRequestSchema, raw)) {
      writeJson(socket, protocolError(""));
      return;
    }
    const response = await onRequest(raw);
    if (!Value.Check(ControlResponseSchema, response)) {
      writeJson(socket, protocolError(raw.operationId));
      return;
    }
    writeJson(socket, response);
  } catch {
    writeJson(socket, protocolError(""));
  } finally {
    socket.end();
  }
}

async function writeAndRead(socket: Socket, request: ControlRequest): Promise<ControlResponse | { status: "unreachable" }> {
  writeJson(socket, request);
  try {
    const raw = await readLimitedJson(socket, CONTROL_MAX_BYTES);
    if (!Value.Check(ControlResponseSchema, raw)) return { status: "unreachable" };
    return raw;
  } catch {
    return { status: "unreachable" };
  }
}

function sleepStatus(timeoutMs: number, socket: Socket): Promise<{ status: "timeout" }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: "timeout" });
    }, timeoutMs);
    timer.unref();
  });
}

function readLimitedJson(socket: Socket, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (error: Error) => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        fail(new Error("payload_too_large"));
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      try {
        resolve(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid_json"));
      }
    };
    const onError = (error: Error) => fail(error);
    const onEnd = () => fail(new Error("disconnected"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function writeJson(socket: Socket, value: object): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function protocolError(operationId: string): ControlResponse {
  return { protocolVersion: CONTROL_PROTOCOL_VERSION, status: "protocol_error", operationId: operationId || "unknown" };
}

async function chmodQuiet(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    /* Windows named-pipe paths and some FS ignore POSIX modes */
  }
}
