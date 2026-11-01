import { describe, expect, it, vi } from "vitest";
import { modelSettingsApi } from "@/lib/modelSettings";
import type { ModelSettingsDto } from "@/lib/modelSettings";

/**
 * The `ModelSettingsDto` shape is what the old web reads. The account fields are additions: a payload with
 * them must parse into the same four dropdowns, and a payload without them must still be usable.
 */

const base = {
  config: { adapter: "codex-direct", authMode: "byok", reasoningEffort: "medium", model: "m-1", byokBaseUrl: "https://a.example.com/v1" },
  auth: { mode: "byok", credential: "byok", state: "connected", adapter: "codex-direct" },
  credentials: { siwc: "missing", byok: "connected", claude: "missing" },
  tools: { claude: { available: false, tokenSaved: false }, github: { available: false, tokenSaved: false } },
} as const;

const account = {
  id: "acct_abc1234567",
  name: "Work",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://a.example.com/v1",
  capabilities: {},
  costTier: "standard",
  order: 0,
  credential: "connected",
  implicit: false,
} as const;

function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ModelSettingsDto", () => {
  it("carries the account fields as an optional addition", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply({ ...base, accounts: [account], defaultAccountId: account.id })));
    const dto: ModelSettingsDto = await modelSettingsApi.read();
    expect(dto.accounts).toHaveLength(1);
    expect(dto.defaultAccountId).toBe(account.id);
    // The fields the old web reads are untouched by the addition.
    expect(dto.config).toEqual(base.config);
    expect(dto.tools).toEqual(base.tools);
  });

  it("still reads a response from a daemon that has no account fields", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply(base)));
    const dto: ModelSettingsDto = await modelSettingsApi.read();
    expect(dto.accounts).toBeUndefined();
    expect(dto.defaultAccountId).toBeUndefined();
    expect(dto.config.adapter).toBe("codex-direct");
  });

  it("reports why the account list is missing instead of showing an empty one", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply({ ...base, unusableReason: "corrupt" })));
    const dto: ModelSettingsDto = await modelSettingsApi.read();
    expect(dto.accounts).toBeUndefined();
    expect(dto.unusableReason).toBe("corrupt");
  });
});
