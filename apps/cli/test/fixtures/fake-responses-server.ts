import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A local fake of the Responses API (`POST /v1/responses`, `GET /v1/models`). Each request takes the next
// scripted reply from the queue for its route; never talks to a real OpenAI endpoint.

export type RecordedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
export type Reply = (res: ServerResponse, request?: RecordedRequest) => void | Promise<void>;

export const sseFrame = (o: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(o)}\n\n`;

/** 200 text/event-stream with the given events (objects become `event:`/`data:` frames; strings are written raw). */
export const sse = (events: unknown[]): Reply => (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    const type = e && typeof e === "object" ? (e as { type?: string }).type : undefined;
    res.write(typeof e === "string" ? e : sseFrame(e, type));
  }
  res.end();
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => (res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** Drops the TCP connection without any HTTP response (a network error for the client). */
export const reset: Reply = (res) => {
  res.socket?.destroy();
};

export async function startFakeResponsesServer() {
  const requests: RecordedRequest[] = [];
  const queues: Record<"responses" | "models", Reply[]> = { responses: [], models: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = req.url ?? "";
      const route = req.method === "POST" && url === "/v1/responses" ? "responses" : req.method === "GET" && (url === "/v1/models" || url.startsWith("/v1/models?")) ? "models" : null;
      const reply = route ? queues[route].shift() : undefined;
      if (!reply) {
        res.writeHead(404).end();
        return;
      }
      void reply(res, requests.at(-1));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    baseUrl,
    requests,
    responses: (...replies: Reply[]) => void queues.responses.push(...replies),
    models: (...replies: Reply[]) => void queues.models.push(...replies),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
export type FakeResponsesServer = Awaited<ReturnType<typeof startFakeResponsesServer>>;
