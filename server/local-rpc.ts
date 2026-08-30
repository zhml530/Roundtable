import { randomBytes } from "node:crypto";
import { existsSync, chmodSync, unlinkSync } from "node:fs";
import { createServer, createConnection, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

import { dispatchRequest, type OrchestrationRequest, type OrchestrationResponse } from "./transport.ts";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function createLocalRpcEndpoint(): string {
  const tag = `${process.pid}-${randomBytes(8).toString("hex")}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\Roundtable-${tag}`
    : join(tmpdir(), `Roundtable-${tag}.sock`);
}

export async function startLocalRpcServer(
  endpoint: string,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
): Promise<Server> {
  if (process.platform !== "win32" && existsSync(endpoint)) unlinkSync(endpoint);
  const server = createServer((socket) => {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) return socket.destroy(new Error("RPC frame too large"));
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const raw = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      void (async () => {
        try {
          const wire = JSON.parse(raw) as OrchestrationRequest & { bodyBase64?: string };
          const request: OrchestrationRequest = {
            ...wire,
            body: wire.bodyBase64 ? Buffer.from(wire.bodyBase64, "base64") : wire.body,
          };
          const response = await dispatchRequest(handler, request);
          socket.end(`${JSON.stringify({ ...response, bodyBase64: Buffer.from(response.body).toString("base64"), body: undefined })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ status: 500, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })).toString("base64") })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  if (process.platform !== "win32") {
    server.once("close", () => {
      try { unlinkSync(endpoint); } catch {}
    });
  }
  return server;
}

export function localRpcRequest(endpoint: string, request: OrchestrationRequest): Promise<OrchestrationResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let pending = "";
    const timer = setTimeout(() => socket.destroy(new Error("local RPC timed out")), 10 * 60_000);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) socket.destroy(new Error("RPC response too large"));
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const wire = JSON.parse(pending.trim()) as OrchestrationResponse & { bodyBase64: string };
        resolve({ status: wire.status, headers: wire.headers ?? {}, body: Buffer.from(wire.bodyBase64 ?? "", "base64") });
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => {
      const wire = {
        ...request,
        bodyBase64: request.body ? Buffer.from(request.body).toString("base64") : undefined,
        body: undefined,
      };
      socket.write(`${JSON.stringify(wire)}\n`);
    });
  });
}

export async function localRpcJson(endpoint: string, request: OrchestrationRequest): Promise<Record<string, unknown>> {
  const response = await localRpcRequest(endpoint, request);
  const text = new TextDecoder().decode(response.body);
  const body = text ? JSON.parse(text) : {};
  if (response.status < 200 || response.status >= 300) throw new Error(String(body.error ?? `RPC ${response.status}`));
  return body;
}
