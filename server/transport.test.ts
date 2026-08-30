import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { createLocalRpcEndpoint, localRpcJson, startLocalRpcServer } from "./local-rpc.ts";
import { dispatchRequest } from "./transport.ts";

async function echo(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { "content-type": "application/json", "x-transport": "ipc" });
  res.end(JSON.stringify({ method: req.method, url: req.url, body }));
}

describe("desktop orchestration transport", () => {
  it("dispatches without opening an HTTP listener", async () => {
    const response = await dispatchRequest(echo, {
      method: "POST",
      path: "/api/example?q=1",
      body: JSON.stringify({ ok: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers["x-transport"]).toBe("ipc");
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
      method: "POST",
      url: "/api/example?q=1",
      body: '{"ok":true}',
    });
  });

  it("serves provider helper processes over a private local RPC pipe", async () => {
    const endpoint = createLocalRpcEndpoint();
    const server = await startLocalRpcServer(endpoint, echo);
    try {
      await expect(localRpcJson(endpoint, { path: "/api/internal/example" })).resolves.toMatchObject({
        method: "GET",
        url: "/api/internal/example",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
