// HTTP client for the hub's Room API (`/room/...`), authenticated with the run token. Shared by the Room MCP
// server (`nema mcp`, used by CLI adapters) and the codex-direct tool loop, so both paths hit the same API.

/** Tool output returned to the model is capped at this many UTF-8 bytes (marker included). */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

/** Caps `text` at `maxBytes` UTF-8 bytes (never splitting a character), appending a truncation marker. */
export function capText(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const marker = `…[已截断：原始 ${buf.length} 字节，仅保留前 64KB]`;
  let end = Math.max(0, maxBytes - Buffer.byteLength(marker));
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off to a character boundary
  return buf.subarray(0, end).toString("utf8") + marker;
}

export type RoomResult = { ok: true; json: unknown } | { ok: false; status: number; error: string };
export type AttachmentResult = { ok: true; bytes: Buffer; mime: string } | { ok: false; status: number; error: string };

/** The largest attachment the hub stores (PDF, 20 MB): the default cap on one attachment download. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class RoomClient {
  private readonly base: string;

  /** `signal` (optional) aborts in-flight requests, e.g. when the run times out. */
  constructor(hubUrl: string, private readonly runToken: string, private readonly signal?: AbortSignal) {
    this.base = hubUrl.replace(/\/+$/, "");
  }

  listEntries(): Promise<RoomResult> {
    return this.call("GET", "/entries");
  }

  readEntry(id: string): Promise<RoomResult> {
    return this.call("GET", `/entries/${encodeURIComponent(id)}`);
  }

  upsertEntry(input: unknown): Promise<RoomResult> {
    return this.call("POST", "/entries", input);
  }

  openThread(args: unknown): Promise<RoomResult> {
    return this.call("POST", "/threads", args);
  }

  /** Pin a skill source and offer one of its skills to the user; the hub installs nothing. */
  offerSkillInstall(args: unknown): Promise<RoomResult> {
    return this.call("POST", "/extensions/offer", args);
  }

  /**
   * Tells the hub this task loaded a Skill, so a thread can keep it. A hub without the route (404) is
   * an older hub: that counts as done.
   */
  async reportSkillActivation(skillId: string, revision: string): Promise<RoomResult> {
    const result = await this.call("POST", "/skills/activated", { skillId, revision });
    return !result.ok && result.status === 404 ? { ok: true, json: null } : result;
  }

  listPluginTools(): Promise<RoomResult> {
    return this.call("GET", "/plugins");
  }

  callPlugin(name: string, args: unknown): Promise<RoomResult> {
    return this.call("POST", `/plugins/${encodeURIComponent(name)}`, args);
  }

  /**
   * Raw bytes of one attachment in this task's delivery set. Reading stops once more than `maxBytes`
   * arrive (an error body stops at 64 KB), so a wrong hub cannot make the daemon buffer an unbounded body.
   */
  async fetchAttachment(id: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<AttachmentResult> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/room/attachments/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${this.runToken}` },
        signal: this.signal,
      });
    } catch (e) {
      return { ok: false, status: 0, error: `无法连接 hub：${e instanceof Error ? e.message : String(e)}` };
    }
    let body: { bytes: Buffer; over: boolean };
    try {
      body = await readCapped(res, res.ok ? maxBytes : MAX_TOOL_OUTPUT_BYTES);
    } catch (e) {
      return { ok: false, status: 0, error: `读取附件失败：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) {
      const text = body.bytes.toString("utf8");
      let err: unknown;
      try {
        err = body.over ? undefined : (JSON.parse(text) as { error?: unknown }).error;
      } catch {
        // non-JSON body
      }
      return { ok: false, status: res.status, error: capText(typeof err === "string" ? err : text || `hub returned HTTP ${res.status}`) };
    }
    if (body.over) return { ok: false, status: res.status, error: `附件超过 ${maxBytes} 字节` };
    return { ok: true, bytes: body.bytes, mime: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<RoomResult> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.base}/room${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.runToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: this.signal,
      });
      text = await res.text();
    } catch (e) {
      return { ok: false, status: 0, error: `无法连接 hub：${e instanceof Error ? e.message : String(e)}` };
    }
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      const err = isJson && parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
      return { ok: false, status: res.status, error: capText(typeof err === "string" ? err : text || `hub returned HTTP ${res.status}`) };
    }
    return { ok: true, json: isJson ? parsed : capText(text) };
  }
}

/** Reads at most `limit` bytes of a response body, then cancels it; `over` says more was on the way. */
async function readCapped(res: Response, limit: number): Promise<{ bytes: Buffer; over: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), over: false };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), over: false };
    const room = limit - size;
    if (value.byteLength > room) {
      chunks.push(Buffer.from(value.subarray(0, room)));
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(chunks), over: true };
    }
    size += value.byteLength;
    chunks.push(Buffer.from(value));
  }
}
