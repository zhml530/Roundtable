export interface OrchestrationEvent {
  kind?: string;
  [key: string]: any;
}

function bridge() {
  const value = (globalThis as typeof globalThis & {
    ogb?: {
      orchestration?: {
        request(request: {
          path: string;
          method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          headers?: Record<string, string>;
          body?: string | Uint8Array;
        }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
        onEvent(cb: (frame: OrchestrationEvent) => void): () => void;
      };
    };
  }).ogb?.orchestration;
  if (!value) throw new Error("Roundtable requires its Electron desktop bridge");
  return value;
}

async function requestBody(body: unknown): Promise<string | Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("unsupported orchestration request body");
}

/** Fetch-compatible facade backed by Electron IPC, not a network request. */
export async function orchestrationFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
  const pending = bridge().request({
    path,
    method: (init.method?.toUpperCase() ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: await requestBody(init.body),
  });
  const result = init.signal
    ? await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        ),
      ])
    : await pending;
  return new Response(Uint8Array.from(result.body).buffer, { status: result.status, headers: result.headers });
}

export function subscribeOrchestrationEvents(listener: (frame: OrchestrationEvent) => void): () => void {
  return bridge().onEvent(listener);
}

export function orchestrationResourceUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith("/api/attachments/") ? `roundtable-resource://app${path}` : path;
}
