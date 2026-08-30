import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createLocalRpcEndpoint, startLocalRpcServer } from "./local-rpc.ts";

process.env.OMB_TRANSPORT = "ipc";
process.env.OMB_HARNESS_PIPE = createLocalRpcEndpoint();

type UtilityParentPort = EventEmitter & { postMessage(message: unknown): void };
const parentPort = (process as typeof process & { parentPort?: UtilityParentPort }).parentPort;

if (!parentPort) throw new Error("Roundtable orchestration host requires an Electron utility-process parent port");

const post = (message: unknown) => parentPort.postMessage(message);
let closeLocalRpcServer = () => {};

// Importing the harness initializes every configured provider and can include
// bounded CLI/model/auth probes. Accept Electron IPC first and let requests
// wait on that initialization promise; provider speed must not decide whether
// the desktop treats a healthy child as a startup failure.
const initialization = (async () => {
  const { handleRequest, subscribeDesktopFrames } = await import("./index.ts");
  const localRpcServer = await startLocalRpcServer(process.env.OMB_HARNESS_PIPE!, handleRequest);
  closeLocalRpcServer = () => localRpcServer.close();
  subscribeDesktopFrames((frame) => post({ type: "roundtable:event", frame }));
  return handleRequest;
})();

export interface DesktopRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface DesktopResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

class IpcRequest extends Readable {
  readonly url: string;
  readonly method: string;
  readonly headers: IncomingHttpHeaders;

  constructor(request: DesktopRequest) {
    super();
    this.url = request.path;
    this.method = request.method ?? "GET";
    this.headers = {
      host: "127.0.0.1",
      "content-type": "application/json",
      ...request.headers,
    };
    if (request.body) this.push(Buffer.from(request.body));
    this.push(null);
  }
}

class IpcResponse extends EventEmitter {
  statusCode = 200;
  private responseHeaders: Record<string, string> = {};
  private chunks: Buffer[] = [];
  private settled = false;

  constructor(private readonly finish: (response: DesktopResponse) => void) {
    super();
  }

  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) {
      this.responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (this.settled) return this;
    if (chunk !== undefined) this.write(chunk);
    this.settled = true;
    this.finish({
      status: this.statusCode,
      headers: this.responseHeaders,
      body: new Uint8Array(Buffer.concat(this.chunks)),
    });
    this.emit("finish");
    return this;
  }
}

type HostMessage =
  | { type: "roundtable:request"; id: string; request: DesktopRequest }
  | { type: "Roundtable:managed-composio"; access?: unknown };

parentPort.on("message", async (event: { data?: HostMessage } | HostMessage) => {
  const message = ("data" in event ? event.data : event) as HostMessage | undefined;
  if (!message || message.type !== "roundtable:request") return;
  try {
    const handleRequest = await initialization;
    const response = await new Promise<DesktopResponse>((resolve, reject) => {
      const req = new IpcRequest(message.request);
      const res = new IpcResponse(resolve);
      void handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse).catch(reject);
    });
    post({ type: "roundtable:response", id: message.id, response });
  } catch (error) {
    post({
      type: "roundtable:response",
      id: message.id,
      response: {
        status: 500,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })),
      },
    });
  }
});

post({ type: "roundtable:ready", pid: process.pid, endpoint: process.env.OMB_HARNESS_PIPE });

process.once("exit", () => closeLocalRpcServer());
