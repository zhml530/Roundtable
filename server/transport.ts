import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export interface OrchestrationRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface OrchestrationResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

class TransportRequest extends Readable {
  readonly url: string;
  readonly method: string;
  readonly headers: IncomingHttpHeaders;

  constructor(request: OrchestrationRequest) {
    super();
    this.url = request.path;
    this.method = request.method ?? "GET";
    this.headers = { host: "127.0.0.1", "content-type": "application/json", ...request.headers };
    if (request.body) this.push(Buffer.from(request.body));
    this.push(null);
  }
}

class TransportResponse extends EventEmitter {
  statusCode = 200;
  private responseHeaders: Record<string, string> = {};
  private chunks: Buffer[] = [];
  private settled = false;
  private readonly finish: (response: OrchestrationResponse) => void;

  constructor(finish: (response: OrchestrationResponse) => void) {
    super();
    this.finish = finish;
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

export function dispatchRequest(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
  request: OrchestrationRequest,
): Promise<OrchestrationResponse> {
  return new Promise((resolve, reject) => {
    const req = new TransportRequest(request);
    const res = new TransportResponse(resolve);
    void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse).catch(reject);
  });
}
