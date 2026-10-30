import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRecord } from "@nema/shared";
import { McpServerControls, McpServerForm, parseValueLines } from "@/components/McpServerPanel";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";

vi.mock("@/lib/hub", () => ({
  saveMcpServer: vi.fn(),
  getMcpServer: vi.fn(),
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
  setMcpSecret: vi.fn(),
  clearMcpSecret: vi.fn(),
  getMcpServerStatus: vi.fn(),
}));

const MARK = "nema-test-secret-7f3a";

const record = (mcp: Partial<NonNullable<ExtensionRecord["mcp"]>> = {}): ExtensionRecord => ({
  id: "search", kind: "mcp", name: "Search", summary: "", source: "mcp:stdio", revision: "abcdef123456", provision: "managed",
  installState: "installed", useState: "enabled", availability: "ready", externalPath: null, error: null,
  mcp: { transport: "stdio", connection: "disconnected", server: null, tools: [], secrets: [{ name: "API_TOKEN", configured: false }], lastError: null, ...mcp },
});

const wrap = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(hub)) if (typeof fn === "function" && "mockReset" in fn) (fn as any).mockReset();
});

describe("parseValueLines", () => {
  it("reads values, secret and env references, and refuses a line without =", () => {
    expect(parseValueLines("LOG=debug\nAPI_TOKEN=secret:API_TOKEN\n\nHOME_DIR=env:HOME\nNOTE=value:secret:x")).toEqual({
      LOG: { value: "debug" }, API_TOKEN: { secret: "API_TOKEN" }, HOME_DIR: { env: "HOME" }, NOTE: { value: "secret:x" },
    });
    expect(() => parseValueLines("oops")).toThrow(/oops/);
  });

  it("keeps a value as typed and keeps every name as its own entry", () => {
    expect(parseValueLines("PAD=  two spaces  \r\nEMPTY=")).toEqual({ PAD: { value: "  two spaces  " }, EMPTY: { value: "" } });
    const parsed = parseValueLines("__proto__=x");
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(JSON.stringify(parsed)).toBe('{"__proto__":{"value":"x"}}');
  });
});

describe("McpServerForm", () => {
  it("saves a stdio server with one argument per line", async () => {
    vi.mocked(hub.saveMcpServer).mockResolvedValue(record());
    const saved = vi.fn();
    wrap(<McpServerForm onSaved={saved} />);
    fireEvent.change(screen.getByLabelText("Id"), { target: { value: "search" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Search" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), { target: { value: "server.mjs\n--port=0\n\n --name \n" } });
    fireEvent.change(screen.getByLabelText("Environment (NAME=value, NAME=secret:REF or NAME=env:VAR)"), { target: { value: "API_TOKEN=secret:API_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(hub.saveMcpServer).toHaveBeenCalledWith({
      id: "search", name: "Search", create: true,
      config: { transport: "stdio", command: "node", args: ["server.mjs", "--port=0", "", " --name "], env: { API_TOKEN: { secret: "API_TOKEN" } } },
    });
  });

  it("saves an HTTP server with headers", async () => {
    vi.mocked(hub.saveMcpServer).mockResolvedValue(record());
    wrap(<McpServerForm onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Id"), { target: { value: "web" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Web" } });
    fireEvent.click(screen.getByLabelText("HTTP"));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("Headers (NAME=value, NAME=secret:REF or NAME=env:VAR)"), { target: { value: "Authorization=secret:AUTH" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    await waitFor(() => expect(hub.saveMcpServer).toHaveBeenCalledWith({
      id: "web", name: "Web", create: true, config: { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: { secret: "AUTH" } } },
    }));
  });

  it("shows the hub's refusal", async () => {
    vi.mocked(hub.saveMcpServer).mockRejectedValue(new Error('invalid MCP config: "API_TOKEN" looks like a credential; use a { secret } or { env } reference'));
    wrap(<McpServerForm onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Id"), { target: { value: "search" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Search" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    expect(await screen.findByText(/looks like a credential/)).toBeTruthy();
  });
});

describe("McpServerControls", () => {
  it("starts and stops, and shows the connection, server and tools", async () => {
    const changed = vi.fn();
    vi.mocked(hub.startMcpServer).mockResolvedValue({ id: "search", connection: "connected", server: { name: "fake", version: "1" }, tools: [{ name: "lookup", schemaDigest: "a".repeat(64) }], lastError: null });
    wrap(<McpServerControls extension={record()} onChanged={changed} />);
    expect(screen.getByText("Disconnected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(hub.startMcpServer).toHaveBeenCalledWith("search"));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("shows a stop button and tool names when connected, and the last error when not", () => {
    const { unmount } = wrap(<McpServerControls extension={record({ connection: "connected", server: { name: "fake", version: "1.2" }, tools: [{ name: "lookup", schemaDigest: "a".repeat(64) }] })} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByText("lookup")).toBeTruthy();
    expect(screen.getByText(/fake 1\.2/)).toBeTruthy();
    unmount();
    wrap(<McpServerControls extension={record({ connection: "needs-login", lastError: "the server asked for a login (HTTP 401)" })} onChanged={() => {}} />);
    expect(screen.getByText("Needs login")).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
  });

  it("a credential box is write-only: it sends the value, clears itself and never shows a stored value", async () => {
    vi.mocked(hub.setMcpSecret).mockResolvedValue({ id: "search", name: "API_TOKEN", configured: true, status: { id: "search", connection: "disconnected", server: null, tools: [], lastError: null } });
    const changed = vi.fn();
    wrap(<McpServerControls extension={record()} onChanged={changed} />);
    const slot = screen.getByText("API_TOKEN").closest("li")!;
    expect(within(slot).getByText("Not set")).toBeTruthy();
    const box = within(slot).getByLabelText("New value for API_TOKEN") as HTMLInputElement;
    expect(box.type).toBe("password");
    expect(box.autocomplete).toBe("new-password");
    fireEvent.change(box, { target: { value: MARK } });
    fireEvent.click(within(slot).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(hub.setMcpSecret).toHaveBeenCalledWith("search", "API_TOKEN", MARK));
    await waitFor(() => expect(box.value).toBe(""));
    expect(document.body.innerHTML).not.toContain(MARK);
    expect(changed).toHaveBeenCalled();
  });

  it("a set credential can be cleared, and shows only that it is set", async () => {
    vi.mocked(hub.clearMcpSecret).mockResolvedValue({ id: "search", name: "API_TOKEN", configured: false, status: { id: "search", connection: "disconnected", server: null, tools: [], lastError: null } });
    wrap(<McpServerControls extension={record({ secrets: [{ name: "API_TOKEN", configured: true }] })} onChanged={() => {}} />);
    const slot = screen.getByText("API_TOKEN").closest("li")!;
    expect(within(slot).getByText("Set")).toBeTruthy();
    fireEvent.click(within(slot).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(hub.clearMcpSecret).toHaveBeenCalledWith("search", "API_TOKEN"));
  });

  it("edit loads the saved config into the form", async () => {
    vi.mocked(hub.getMcpServer).mockResolvedValue({ id: "search", name: "Search", config: { transport: "stdio", command: "node", args: ["server.mjs"], env: { API_TOKEN: { secret: "API_TOKEN" } } }, secrets: [] });
    wrap(<McpServerControls extension={record()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(((await screen.findByLabelText("Command")) as HTMLInputElement).value).toBe("node");
    expect((screen.getByLabelText("Environment (NAME=value, NAME=secret:REF or NAME=env:VAR)") as HTMLTextAreaElement).value).toBe("API_TOKEN=secret:API_TOKEN");
    expect((screen.getByLabelText("Id") as HTMLInputElement).readOnly).toBe(true);
    vi.mocked(hub.saveMcpServer).mockResolvedValue(record());
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    await waitFor(() => expect(hub.saveMcpServer).toHaveBeenCalledWith({ id: "search", name: "Search", config: { transport: "stdio", command: "node", args: ["server.mjs"], env: { API_TOKEN: { secret: "API_TOKEN" } } } }));
  });

  it("a disabled server cannot be started from here", () => {
    wrap(<McpServerControls extension={{ ...record(), useState: "disabled" }} onChanged={() => {}} />);
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a damaged config (cut off or edited outside Nema) is recovered by entering it again", async () => {
    const damaged = { ...record({ secrets: [] }), availability: "damaged" as const, error: "mcp-config-damaged" };
    wrap(<McpServerControls extension={damaged} onChanged={() => {}} />);
    expect(screen.getByText(/missing or was changed outside Nema/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const command = (await screen.findByLabelText("Command")) as HTMLInputElement;
    expect(command.value).toBe("");
    expect((screen.getByLabelText("Id") as HTMLInputElement).value).toBe("search");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Search");
    expect(hub.getMcpServer).not.toHaveBeenCalled();
    vi.mocked(hub.saveMcpServer).mockResolvedValue(record());
    fireEvent.change(command, { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    await waitFor(() => expect(hub.saveMcpServer).toHaveBeenCalledWith({ id: "search", name: "Search", config: { transport: "stdio", command: "node", args: [], env: {} } }));
  });

  it("Stop on a connected server stops it and refreshes the row", async () => {
    vi.mocked(hub.stopMcpServer).mockResolvedValue({ id: "search", connection: "disconnected", server: null, tools: [], lastError: null });
    const changed = vi.fn();
    wrap(<McpServerControls extension={record({ connection: "connected" })} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(hub.stopMcpServer).toHaveBeenCalledWith("search"));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("while a start is pending the row says Connecting and Stop can cancel it", async () => {
    let finish!: (status: hub.McpServerStatus) => void;
    vi.mocked(hub.startMcpServer).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(hub.stopMcpServer).mockResolvedValue({ id: "search", connection: "disconnected", server: null, tools: [], lastError: null });
    wrap(<McpServerControls extension={record()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Connecting")).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(hub.stopMcpServer).toHaveBeenCalledWith("search"));
    finish({ id: "search", connection: "disconnected", server: null, tools: [], lastError: null });
    expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("a running server's row checks its status while the page is open", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(hub.getMcpServerStatus).mockResolvedValue({ id: "search", connection: "error", server: null, tools: [], lastError: "the server exited" });
      const changed = vi.fn();
      wrap(<McpServerControls extension={record({ connection: "connected" })} onChanged={changed} />);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(hub.getMcpServerStatus).toHaveBeenCalledWith("search");
      expect(changed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful recovery save closes the form and tells the page", async () => {
    const damaged = { ...record({ secrets: [] }), availability: "damaged" as const, error: "mcp-config-damaged" };
    const changed = vi.fn();
    const saved = record();
    vi.mocked(hub.saveMcpServer).mockResolvedValue(saved);
    wrap(<McpServerControls extension={damaged} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Command"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(saved));
    expect(screen.queryByRole("button", { name: "Save MCP server" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});

