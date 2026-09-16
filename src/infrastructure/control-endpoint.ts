import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, posix } from "node:path";
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

/** Darwin `sockaddr_un.sun_path` is 104 bytes; deep mkdtemp and `os.tmpdir()` `/var/folders` paths truncate. */
export const UNIX_CONTROL_SOCK_MAX = 96;

export function controlUnixSocketPath(ownerInstanceId: string, tmp = "/tmp"): string {
  const id = ownerInstanceId.replace(/^own-/, "").replace(/[^A-Za-z0-9-]/g, "");
  const compact = `rp-${id.replace(/-/g, "").slice(0, 24)}`;
  const preferred = posix.join(tmp, `${compact}.sock`);
  if (preferred.length <= UNIX_CONTROL_SOCK_MAX) return preferred;
  return posix.join("/tmp", `${compact.slice(-12)}.sock`);
}

export function controlEndpointFor(
  ownerInstanceId: string,
  _ipcDir: string,
  platform: NodeJS.Platform = process.platform,
): ControlEndpoint {
  if (platform === "win32") return { kind: "pipe", name: `\\\\.\\pipe\\reprise-${ownerInstanceId}` };
  return { kind: "unix", path: controlUnixSocketPath(ownerInstanceId) };
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
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    void serveSocket(socket, input.onRequest);
  });
  await bindEndpoint(server, input.endpoint);
  server.unref();
  if (input.endpoint.kind === "unix") await chmodQuiet(input.endpoint.path, 0o700);
  return {
    close: async () => {
      await closeListeningServer(server, connections);
      if (input.endpoint.kind !== "unix") return;
      await unlink(input.endpoint.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

export async function sendControlRequest(
  endpoint: ControlEndpoint,
  request: ControlRequest,
  timeoutMs = CONTROL_CLIENT_TIMEOUT_MS,
): Promise<ControlResponse | { status: "unreachable" } | { status: "timeout" }> {
  const socket = connectEndpoint(endpoint);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = await Promise.race([
      writeAndRead(socket, request),
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          socket.destroy();
          resolve({ status: "timeout" });
        }, timeoutMs);
      }),
    ]);
    return payload;
  } catch {
    return { status: "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
    socket.destroy();
  }
}

function closeListeningServer(server: Server, connections: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    for (const socket of connections) socket.destroy();
    server.close((error) => {
      // Darwin can leave a half-open unix client after cancel; the owner is retiring this endpoint.
      void error;
      finish();
    });
    setTimeout(finish, 250).unref();
  });
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
