import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRecord } from "@nema/shared";
import { PluginsPage } from "@/components/PluginsPage";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";

vi.mock("@/lib/hub", () => ({
  listExtensions: vi.fn(),
  listPlugins: vi.fn(),
  setExtensionUse: vi.fn(),
  removeExtension: vi.fn(),
  resolveExtensionSource: vi.fn(),
  installExtension: vi.fn(),
  getExtensionInstall: vi.fn(),
  cancelExtensionInstall: vi.fn(),
  retryExtensionInstall: vi.fn(),
  discoverExtensions: vi.fn(),
  attachExtension: vi.fn(),
  repairExtension: vi.fn(),
  pickDirectory: vi.fn(),
  saveMcpServer: vi.fn(),
  getMcpServer: vi.fn(),
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
  setMcpSecret: vi.fn(),
  clearMcpSecret: vi.fn(),
  getMcpServerStatus: vi.fn(),
}));

const emptyDiscovery = {
  locations: [
    { label: "claude", path: "/home/me/.claude/skills", found: false },
    { label: "codex", path: "/home/me/.codex/skills", found: false },
    { label: "agents", path: "/home/me/.agents/skills", found: false },
  ],
  skills: [],
  truncated: false,
};

const row = (partial: Pick<ExtensionRecord, "id" | "name"> & Partial<ExtensionRecord>): ExtensionRecord => ({
  kind: "plugin",
  summary: "",
  source: "bundled",
  revision: "bundled",
  provision: "bundled",
  installState: "installed",
  useState: "enabled",
  availability: "ready",
  externalPath: null,
  error: null,
  ...partial,
});

const catalog: ExtensionRecord[] = [
  row({ id: "code", name: "graphify", availability: "missing-dependency", error: "bundled-runtime-missing" }),
  row({ id: "github", name: "GitHub" }),
];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(hub.listExtensions).mockReset();
  vi.mocked(hub.listExtensions).mockResolvedValue(catalog);
  vi.mocked(hub.setExtensionUse).mockReset();
  vi.mocked(hub.removeExtension).mockReset();
  for (const fn of [hub.resolveExtensionSource, hub.installExtension, hub.getExtensionInstall, hub.cancelExtensionInstall, hub.retryExtensionInstall]) vi.mocked(fn).mockReset();
  for (const fn of [hub.discoverExtensions, hub.attachExtension, hub.repairExtension, hub.pickDirectory]) vi.mocked(fn).mockReset();
  vi.mocked(hub.discoverExtensions).mockResolvedValue(emptyDiscovery);
});

describe("PluginsPage", () => {
  it("shows provision, install, and use separately, and a repair note instead of a uv command", async () => {
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Extensions" })).toBeTruthy();
    const graphify = screen.getByRole("heading", { name: "graphify" }).closest("section")!;
    expect(within(graphify).getByText("Bundled with the app")).toBeTruthy();
    expect(within(graphify).getByText("Installed").classList.contains("status-bad")).toBe(true);
    expect(within(graphify).getByText("Enabled").classList.contains("status-bad")).toBe(true);
    expect(within(graphify).getByText("The packaged Graphify runtime is missing. It can be repaired from here.")).toBeTruthy();
    expect(within(graphify).queryByText(/uv tool install/)).toBeNull();
    expect(within(graphify).getByText("code__search")).toBeTruthy();
    expect(screen.getByText("Sends data out").classList.contains("red")).toBe(true);
  });

  it("keeps GitHub connection and token text off the extensions page", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([
      catalog[0]!,
      row({ id: "github", name: "GitHub", revision: "gh 2.67.0" }),
    ]);
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "GitHub" });
    const block = heading.closest("section")!;
    expect(within(block).getByText("Sends data out").classList.contains("red")).toBe(true);
    expect(within(block).getByText("github__issue_read")).toBeTruthy();
    expect(within(block).getByText("Installed").classList.contains("status-ok")).toBe(true);
    expect(within(block).getByText("Enabled").classList.contains("status-ok")).toBe(true);
    expect(within(block).getByText("Bundled with the app").classList.contains("status-bad")).toBe(false);
    expect(within(block).queryByText(/gh 2\.67\.0|令牌不存在/)).toBeNull();
    expect(within(block).queryByText(/GitHub connection is/)).toBeNull();
    expect(within(block).queryByText(/authenticated local gh command|nema auth github|personal access token|uv tool install/i)).toBeNull();
    expect(within(block).queryByLabelText(/token/i)).toBeNull();
  });

  it("embeds without the overlay close button", async () => {
    render(
      <I18nProvider>
        <PluginsPage embedded />
      </I18nProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Extensions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(document.querySelector(".plugins-page.embedded")).toBeTruthy();
    expect(hub.listExtensions).toHaveBeenCalledOnce();
  });
});

describe("PluginsPage use state", () => {
  it("disables an enabled extension and shows the new state without a reload", async () => {
    const { setExtensionUse } = hub as unknown as { setExtensionUse: ReturnType<typeof vi.fn> };
    setExtensionUse.mockResolvedValue({ ...catalog[1]!, useState: "disabled" });
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    const github = (await screen.findByRole("heading", { name: "GitHub" })).closest("section")!;
    const button = within(github).getByRole("button", { name: "Disable" });
    await act(async () => {
      button.click();
    });

    expect(setExtensionUse).toHaveBeenCalledWith("github", "disabled");
    expect(await within(github).findByText("Disabled")).toBeTruthy();
    expect(within(github).getByRole("button", { name: "Enable" })).toBeTruthy();
  });

  it("offers Enable for a disabled extension", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, row({ id: "github", name: "GitHub", useState: "disabled" })]);
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );
    const github = (await screen.findByRole("heading", { name: "GitHub" })).closest("section")!;
    expect(within(github).getByRole("button", { name: "Enable" })).toBeTruthy();
  });

  it("shows the failure and keeps the old state when the toggle is refused", async () => {
    const { setExtensionUse } = hub as unknown as { setExtensionUse: ReturnType<typeof vi.fn> };
    setExtensionUse.mockRejectedValue(new Error("daemon 已断开"));
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );
    const github = (await screen.findByRole("heading", { name: "GitHub" })).closest("section")!;
    await act(async () => {
      within(github).getByRole("button", { name: "Disable" }).click();
    });
    expect(await screen.findByText("daemon 已断开")).toBeTruthy();
    expect(within(github).getByText("Enabled")).toBeTruthy();
    expect(within(github).getByRole("button", { name: "Disable" })).toBeTruthy();
  });
});

describe("PluginsPage concurrent toggles", () => {
  it("leaves another extension's button usable while one toggle is in flight", async () => {
    const { setExtensionUse } = hub as unknown as { setExtensionUse: ReturnType<typeof vi.fn> };
    let release: (row: ExtensionRecord) => void = () => {};
    setExtensionUse.mockReturnValue(new Promise<ExtensionRecord>((resolve) => { release = resolve; }));
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    const github = (await screen.findByRole("heading", { name: "GitHub" })).closest("section")!;
    const graphify = screen.getByRole("heading", { name: "graphify" }).closest("section")!;
    await act(async () => {
      within(github).getByRole("button", { name: "Disable" }).click();
    });
    expect((within(github).getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(true);
    // graphify is a different extension, so its own switch stays live.
    expect((within(graphify).getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      release({ ...catalog[1]!, useState: "disabled" });
    });
    expect(await within(github).findByText("Disabled")).toBeTruthy();
  });

  it("ignores a stale answer that arrives after a newer click", async () => {
    const { setExtensionUse } = hub as unknown as { setExtensionUse: ReturnType<typeof vi.fn> };
    const resolvers: ((row: ExtensionRecord) => void)[] = [];
    setExtensionUse.mockImplementation(() => new Promise<ExtensionRecord>((resolve) => { resolvers.push(resolve); }));
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    const github = (await screen.findByRole("heading", { name: "GitHub" })).closest("section")!;
    await act(async () => {
      within(github).getByRole("button", { name: "Disable" }).click();
    });
    // The first click is still pending, so a second one is refused at the source.
    await act(async () => {
      within(github).getByRole("button", { name: "Disable" }).click();
    });
    expect(setExtensionUse).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers[0]!({ ...catalog[1]!, useState: "disabled" });
    });
    expect(await within(github).findByText("Disabled")).toBeTruthy();
  });
});

describe("PluginsPage removal", () => {
  const managed = row({ id: "skill", name: "Research skill", provision: "managed", source: "nema install" });
  const external = row({ id: "remote", name: "Remote skill", provision: "external", source: "https://example.com", externalPath: "/tmp/remote" });

  const renderPage = () =>
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

  it("offers no removal for a bundled extension", async () => {
    renderPage();
    const graphify = (await screen.findByRole("heading", { name: "graphify" })).closest("section")!;
    expect(within(graphify).getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(within(graphify).queryByRole("button", { name: /uninstall|remove/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
  });

  it("removes a managed extension only after the inline confirm, and never toggles it", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, managed]);
    vi.mocked(hub.removeExtension).mockResolvedValue({ id: "skill", removed: "managed" });
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Research skill" })).closest("section")!;
    await act(async () => {
      within(block).getByRole("button", { name: "Uninstall" }).click();
    });
    // The first click only opens the confirmation; nothing has been deleted yet.
    expect(hub.removeExtension).not.toHaveBeenCalled();
    expect(within(block).getByText("Uninstalling deletes the extension directory Nema installed.")).toBeTruthy();

    await act(async () => {
      within(block).getByRole("button", { name: "Confirm uninstall" }).click();
    });
    expect(hub.removeExtension).toHaveBeenCalledWith("skill");
    expect(hub.setExtensionUse).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "Research skill" })).toBeNull();
    expect(screen.getByRole("heading", { name: "graphify" })).toBeTruthy();
  });

  it("cancelling the confirmation leaves the extension alone", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, managed]);
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Research skill" })).closest("section")!;
    await act(async () => {
      within(block).getByRole("button", { name: "Uninstall" }).click();
    });
    await act(async () => {
      within(block).getByRole("button", { name: "Cancel" }).click();
    });
    expect(within(block).getByRole("button", { name: "Uninstall" })).toBeTruthy();
    expect(within(block).queryByRole("button", { name: "Confirm uninstall" })).toBeNull();
    expect(hub.removeExtension).not.toHaveBeenCalled();
  });

  it("asks to remove an external extension from the list, not to uninstall it", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, external]);
    vi.mocked(hub.removeExtension).mockResolvedValue({ id: "remote", removed: "external" });
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Remote skill" })).closest("section")!;
    expect(within(block).queryByRole("button", { name: "Uninstall" })).toBeNull();
    await act(async () => {
      within(block).getByRole("button", { name: "Remove from list" }).click();
    });
    expect(
      within(block).getByText("Only the list entry goes away; the files outside Nema stay exactly as they are."),
    ).toBeTruthy();
    await act(async () => {
      within(block).getByRole("button", { name: "Confirm removal" }).click();
    });
    expect(hub.removeExtension).toHaveBeenCalledWith("remote");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "Remote skill" })).toBeNull();
  });

  it("shows the failure and keeps the row when the removal is refused", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, managed]);
    vi.mocked(hub.removeExtension).mockRejectedValue(new Error("bundled extensions cannot be removed"));
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Research skill" })).closest("section")!;
    await act(async () => {
      within(block).getByRole("button", { name: "Uninstall" }).click();
    });
    await act(async () => {
      within(block).getByRole("button", { name: "Confirm uninstall" }).click();
    });
    expect(await screen.findByText("bundled extensions cannot be removed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Research skill" })).toBeTruthy();
    // The row is usable again: the confirmation closed and the switch never went pending forever.
    expect(within(block).getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  it("reloads the list after a refused removal and drops a row that is already gone", async () => {
    // The response can be lost after the daemon already removed the extension, or another tab can
    // remove it first. Without a reload the row would stay, and every retry would say "not found".
    vi.mocked(hub.listExtensions).mockResolvedValueOnce([catalog[0]!, managed]);
    vi.mocked(hub.removeExtension).mockRejectedValue(new Error("daemon 已断开"));
    vi.mocked(hub.listExtensions).mockResolvedValueOnce([catalog[0]!]);
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Research skill" })).closest("section")!;
    await act(async () => {
      within(block).getByRole("button", { name: "Uninstall" }).click();
    });
    await act(async () => {
      within(block).getByRole("button", { name: "Confirm uninstall" }).click();
    });
    expect(await screen.findByText("daemon 已断开")).toBeTruthy();
    expect(hub.listExtensions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "Research skill" })).toBeNull();
    expect(screen.getByRole("heading", { name: "graphify" })).toBeTruthy();
  });

  it("keeps the row and closes the confirmation when the reload still lists it", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, managed]);
    vi.mocked(hub.removeExtension).mockRejectedValue(new Error("extension is not managed"));
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Research skill" })).closest("section")!;
    await act(async () => {
      within(block).getByRole("button", { name: "Uninstall" }).click();
    });
    await act(async () => {
      within(block).getByRole("button", { name: "Confirm uninstall" }).click();
    });
    expect(await screen.findByText("extension is not managed")).toBeTruthy();
    expect(hub.listExtensions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Research skill" })).toBeTruthy();
    // The confirmation is answered, so the row goes back to its normal button.
    expect(within(block).getByRole("button", { name: "Uninstall" })).toBeTruthy();
    expect(within(block).queryByRole("button", { name: "Confirm uninstall" })).toBeNull();
  });

  it("refuses a second click while the removal is in flight", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([catalog[0]!, managed]);
    let release: (value: { id: string; removed: "managed" }) => void = () => {};
    vi.mocked(hub.removeExtension).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderPage();

    const block = (await screen.findByRole("heading", { name: "Research skill" })).closest("section")!;
    await act(async () => {
      within(block).getByRole("button", { name: "Uninstall" }).click();
    });
    await act(async () => {
      within(block).getByRole("button", { name: "Confirm uninstall" }).click();
    });
    const confirm = within(block).getByRole("button", { name: "Confirm uninstall" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      confirm.click();
    });
    expect(hub.removeExtension).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ id: "skill", removed: "managed" });
    });
  });
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const preview = {
  repository: "https://github.com/acme/skills",
  owner: "acme",
  repo: "skills",
  ref: "main",
  commit: COMMIT,
  license: "MIT",
  path: null,
  truncated: false,
  skills: [
    { id: "pdf", name: "pdf", description: "Fill PDF forms", path: "skills/pdf", digest: "a".repeat(40), problem: null, target: "/home/me/.nema/extensions/extensions/pdf", installed: false },
    { id: null, name: "Word", description: "", path: "skills/word", digest: "b".repeat(40), problem: "missing-frontmatter" as const, target: null, installed: false },
    { id: "notes", name: "notes", description: "Notes", path: "notes", digest: "c".repeat(40), problem: null, target: "/home/me/.nema/extensions/extensions/notes", installed: true },
  ],
};
const job = (state: "running" | "installed" | "failed" | "cancelled", done = 0, error: string | null = null) => ({ id: "pdf", state, done, total: 3, error, commit: COMMIT, path: "skills/pdf" });

function renderPage() {
  return render(
    <I18nProvider>
      <PluginsPage pollMs={1} />
    </I18nProvider>,
  );
}

async function previewSource(source = "https://github.com/acme/skills") {
  renderPage();
  const input = await screen.findByLabelText("GitHub repository or skills.sh link");
  fireEvent.change(input, { target: { value: source } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  });
}

describe("installing a skill from the page", () => {
  it("previews a source pinned to its commit, with each skill's target and why a blocked one cannot be installed", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    await previewSource("  https://github.com/acme/skills  ");
    expect(hub.resolveExtensionSource).toHaveBeenCalledWith("https://github.com/acme/skills");
    const panel = screen.getByRole("region", { name: "Install a skill" });
    expect(within(panel).getByText("Pinned to commit 0123456")).toBeTruthy();
    expect(within(panel).getByText("License: MIT")).toBeTruthy();
    const pdf = within(panel).getByText("pdf", { selector: "h4" }).closest("li")!;
    expect(within(pdf).getByText("Fill PDF forms")).toBeTruthy();
    expect(within(pdf).getByText("Installs to /home/me/.nema/extensions/extensions/pdf")).toBeTruthy();
    expect((within(pdf).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(false);
    const word = within(panel).getByText("Word", { selector: "h4" }).closest("li")!;
    expect(within(word).getByText("SKILL.md has no name and description, so it cannot be installed.")).toBeTruthy();
    expect(within(word).queryByRole("button", { name: "Install" })).toBeNull();
    const notes = within(panel).getByText("notes", { selector: "h4" }).closest("li")!;
    expect(within(notes).getByText("Already installed")).toBeTruthy();
    expect(within(notes).queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows why a source could not be read", async () => {
    vi.mocked(hub.resolveExtensionSource).mockRejectedValue(new Error("GitHub repository not found: acme/skills"));
    await previewSource();
    expect(await screen.findByText("GitHub repository not found: acme/skills")).toBeTruthy();
  });

  it("installs the previewed commit and folder, follows progress, and refreshes the list when it finishes", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    vi.mocked(hub.installExtension).mockResolvedValue(job("running"));
    vi.mocked(hub.getExtensionInstall).mockResolvedValueOnce(job("running", 2)).mockResolvedValue(job("installed", 3));
    await previewSource();
    const installed = row({ id: "pdf", name: "pdf", kind: "skill", provision: "managed" });
    // The refresh when the job starts still sees the old list; only the one after it ends has the skill.
    let finished = false;
    vi.mocked(hub.getExtensionInstall).mockReset();
    vi.mocked(hub.getExtensionInstall).mockResolvedValueOnce(job("running", 2)).mockImplementation(async () => {
      finished = true;
      return job("installed", 3);
    });
    vi.mocked(hub.listExtensions).mockImplementation(async () => (finished ? [...catalog, installed] : catalog));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(hub.installExtension).toHaveBeenCalledWith({ source: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf" });
    expect(await screen.findByText("Install finished")).toBeTruthy();
    expect(hub.getExtensionInstall).toHaveBeenCalledWith("pdf");
    expect(await screen.findByRole("heading", { name: "pdf", level: 3 })).toBeTruthy();
  });

  it("cancels a running install from the page", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    vi.mocked(hub.installExtension).mockResolvedValue(job("running"));
    let settle: (value: ReturnType<typeof job>) => void = () => {};
    vi.mocked(hub.getExtensionInstall).mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    vi.mocked(hub.cancelExtensionInstall).mockResolvedValue(job("cancelled"));
    await previewSource();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(screen.getByText("Installing 0/3")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel install" }));
    });
    expect(hub.cancelExtensionInstall).toHaveBeenCalledWith("pdf");
    expect(await screen.findByText("Install cancelled")).toBeTruthy();
    settle(job("cancelled"));
  });

  it("shows a failed install's reason and retries it from the list", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([
      ...catalog,
      row({
        id: "pdf", name: "pdf", kind: "skill", provision: "managed", installState: "failed", error: "skills/pdf/a.md does not match its Git blob hash",
        provenance: { repository: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf", digest: "a".repeat(40), license: null },
      }),
    ]);
    vi.mocked(hub.retryExtensionInstall).mockResolvedValue(job("running"));
    vi.mocked(hub.getExtensionInstall).mockResolvedValue(job("installed", 3));
    renderPage();
    const block = (await screen.findByRole("heading", { name: "pdf", level: 3 })).closest("section")!;
    expect(within(block).getByText("skills/pdf/a.md does not match its Git blob hash")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Retry install" }));
    });
    expect(hub.retryExtensionInstall).toHaveBeenCalledWith("pdf");
    await waitFor(() => expect(hub.getExtensionInstall).toHaveBeenCalledWith("pdf"));
    expect(await screen.findByText("Install finished")).toBeTruthy();
  });

  it("drops a preview as soon as the source is edited, so Install can only use what is shown", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    await previewSource();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("GitHub repository or skills.sh link"), { target: { value: "https://github.com/other/skills" } });
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.queryByText("Pinned to commit 0123456")).toBeNull();
  });

  it("sends one install per click burst and disables the button until the daemon answers", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    let answer: (value: ReturnType<typeof job>) => void = () => {};
    vi.mocked(hub.installExtension).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    vi.mocked(hub.getExtensionInstall).mockResolvedValue(job("installed", 3));
    await previewSource();
    const button = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(button.disabled).toBe(true);
    expect(hub.installExtension).toHaveBeenCalledTimes(1);
    await act(async () => answer(job("running")));
    expect(await screen.findByText("Install finished")).toBeTruthy();
  });

  it("picks up an install that was already running when the page opened", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([...catalog, row({ id: "pdf", name: "pdf", kind: "skill", provision: "managed", installState: "installing" })]);
    vi.mocked(hub.getExtensionInstall).mockResolvedValueOnce(job("running", 1)).mockReturnValue(new Promise(() => {}));
    renderPage();
    const block = (await screen.findByRole("heading", { name: "pdf", level: 3 })).closest("section")!;
    expect(await within(block).findByText("Installing 1/3")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Cancel install" })).toBeTruthy();
  });

  it("keeps polling after a status request fails once", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    vi.mocked(hub.installExtension).mockResolvedValue(job("running"));
    vi.mocked(hub.getExtensionInstall).mockRejectedValueOnce(new Error("daemon 响应超时")).mockResolvedValue(job("installed", 3));
    await previewSource();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(await screen.findByText("Install finished")).toBeTruthy();
  });

  it("does not let an older list answer overwrite a newer one", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    vi.mocked(hub.installExtension).mockResolvedValue(job("running"));
    vi.mocked(hub.getExtensionInstall).mockResolvedValue(job("installed", 3));
    await previewSource();
    const installed = row({ id: "pdf", name: "pdf", kind: "skill", provision: "managed" });
    let first: (rows: ExtensionRecord[]) => void = () => {};
    vi.mocked(hub.listExtensions)
      .mockReturnValueOnce(new Promise((resolve) => { first = resolve; }))
      .mockResolvedValue([...catalog, installed]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(await screen.findByRole("heading", { name: "pdf", level: 3 })).toBeTruthy();
    // The refresh started with the job answers last, with the list from before the install.
    await act(async () => first(catalog));
    expect(screen.getByRole("heading", { name: "pdf", level: 3 })).toBeTruthy();
  });

  it("refreshes again until a cancelled install is no longer recorded as installing", async () => {
    vi.mocked(hub.resolveExtensionSource).mockResolvedValue(preview);
    vi.mocked(hub.installExtension).mockResolvedValue(job("running"));
    vi.mocked(hub.getExtensionInstall).mockReturnValue(new Promise(() => {}));
    vi.mocked(hub.cancelExtensionInstall).mockResolvedValue(job("cancelled"));
    const provenance = { repository: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf", digest: "a".repeat(40), license: null };
    const installing = row({ id: "pdf", name: "pdf", kind: "skill", provision: "managed", installState: "installing", provenance });
    const absent = { ...installing, installState: "absent" as const };
    await previewSource();
    let cancelled = 0;
    vi.mocked(hub.listExtensions).mockImplementation(async () => [...catalog, cancelled > 0 && cancelled++ > 1 ? absent : installing]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    cancelled = 1;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel install" }));
    });
    // A cancelled row moves from the installed list into discover, so the section
    // captured while it still said "installing" is detached and never shows Retry.
    await waitFor(() => {
      const block = screen.getByRole("heading", { name: "pdf", level: 3 }).closest("section")!;
      expect(within(block).getByRole("button", { name: "Retry install" })).toBeTruthy();
    });
  });
});

describe("PluginsPage sections, filter and search", () => {
  const mixed: ExtensionRecord[] = [
    // "code" appears only in this id, so the id search below cannot pass through another field.
    row({ id: "code", name: "graphify", summary: "Repository index" }),
    row({ id: "github", name: "GitHub", summary: "Issues and pull requests" }),
    row({ id: "pdf", name: "pdf", kind: "skill", summary: "Fill PDF forms", provision: "managed", source: "https://github.com/acme/skills/tree/" + "a".repeat(40) + "/skills/pdf", revision: "a".repeat(40) }),
    row({ id: "notes", name: "Notes", kind: "skill", summary: "Take meeting notes", provision: "external", source: "/home/me/.claude/skills/notes", externalPath: "/home/me/.claude/skills/notes" }),
    row({ id: "docs", name: "docs", kind: "mcp", summary: "Docs server", provision: "managed", source: "https://example.com/mcp" }),
    row({
      id: "slides", name: "slides", kind: "skill", summary: "Build decks", provision: "managed", installState: "absent",
      provenance: { repository: "https://github.com/acme/skills", commit: "b".repeat(40), path: "skills/slides", digest: "c".repeat(40), license: null },
    }),
  ];
  const names = (region: HTMLElement) => within(region).queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  const installedRegion = () => screen.getByRole("region", { name: "Installed" });
  const discoverRegion = () => screen.getByRole("region", { name: "Discover & install" });

  beforeEach(() => {
    vi.mocked(hub.listExtensions).mockResolvedValue(mixed);
  });

  it("lists everything present under Installed, and an absent record under Discover & install with the install panel", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "graphify", level: 3 });
    expect(names(installedRegion())).toEqual(["graphify", "GitHub", "pdf", "Notes", "docs"]);
    const discover = discoverRegion();
    expect(within(discover).getByRole("heading", { name: "Install a skill" })).toBeTruthy();
    expect(names(discover)).toContain("slides");
    expect(names(installedRegion())).not.toContain("slides");
    const slides = within(discover).getByRole("heading", { name: "slides", level: 3 }).closest("section")!;
    expect(within(slides).getByRole("button", { name: "Retry install" })).toBeTruthy();
  });

  it("narrows both sections by type without asking the hub again", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "graphify", level: 3 });
    const types = screen.getByRole("radiogroup", { name: "Type" });
    expect(within(types).getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.closest("label")?.textContent)).toEqual(["All", "Skills", "MCP", "Plugins"]);
    expect((within(types).getByRole("radio", { name: "All" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(types).getByRole("radio", { name: "Skills" }));
    expect(names(installedRegion())).toEqual(["pdf", "Notes"]);
    expect(names(discoverRegion())).toContain("slides");
    fireEvent.click(within(types).getByRole("radio", { name: "MCP" }));
    expect(names(installedRegion())).toEqual(["docs"]);
    expect(names(discoverRegion())).not.toContain("slides");
    fireEvent.click(within(types).getByRole("radio", { name: "Plugins" }));
    expect(names(installedRegion())).toEqual(["graphify", "GitHub"]);
    expect(hub.listExtensions).toHaveBeenCalledOnce();
  });

  it("searches name, description, source and id, ignoring case, and says when nothing matches", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "graphify", level: 3 });
    const search = screen.getByRole("searchbox", { name: "Search extensions" });
    fireEvent.change(search, { target: { value: "MEETING" } });
    expect(names(installedRegion())).toEqual(["Notes"]);
    fireEvent.change(search, { target: { value: "acme/skills" } });
    expect(names(installedRegion())).toEqual(["pdf"]);
    expect(names(discoverRegion())).toContain("slides");
    fireEvent.change(search, { target: { value: "code" } });
    expect(names(installedRegion())).toEqual(["graphify"]);
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(names(installedRegion())).toEqual([]);
    expect(within(installedRegion()).getByText("No extensions match.")).toBeTruthy();
    // A match that lives only under Discover & install is a match, not "nothing matches".
    fireEvent.change(search, { target: { value: "decks" } });
    expect(names(installedRegion())).toEqual([]);
    expect(names(discoverRegion())).toEqual(["Install a skill", "Found on this computer", "slides"]);
    expect(screen.queryByText("No extensions match.")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    fireEvent.change(search, { target: { value: "" } });
    expect(names(installedRegion())).toEqual(["pdf", "Notes"]);
  });

  it("a row that is filtered out and shown again still has its running install line", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([
      row({ id: "code", name: "graphify" }),
      row({
        id: "pdf", name: "pdf", kind: "skill", summary: "Fill PDF forms", provision: "managed", installState: "failed", error: "boom",
        provenance: { repository: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf", digest: "c".repeat(40), license: null },
      }),
    ]);
    vi.mocked(hub.retryExtensionInstall).mockResolvedValue(job("running", 1));
    vi.mocked(hub.getExtensionInstall).mockResolvedValue(job("running", 2));
    renderPage();
    const block = (await screen.findByRole("heading", { name: "pdf", level: 3 })).closest("section")!;
    await act(async () => fireEvent.click(within(block).getByRole("button", { name: "Retry install" })));
    expect(await screen.findByText(/Installing [12]\/3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Plugins" }));
    expect(screen.queryByText(/Installing [12]\/3/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(await screen.findByText(/Installing [12]\/3/)).toBeTruthy();
  });
});

describe("PluginsPage attach and repair", () => {
  const renderPage = () =>
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );
  const foundRegion = () => screen.getByRole("region", { name: "Found on this computer" });
  const notes = { path: "/home/me/.claude/skills/notes", location: "claude", name: "Notes", description: "Take meeting notes", id: "notes", attached: false, problem: null };
  const attachedNotes = row({ id: "notes", name: "Notes", kind: "skill", summary: "Take meeting notes", provision: "external", source: notes.path, revision: "local", externalPath: notes.path });

  it("lists skills found on this computer under Discover & install, with Attach or the reason it cannot be attached", async () => {
    vi.mocked(hub.discoverExtensions).mockResolvedValue({
      ...emptyDiscovery,
      skills: [
        notes,
        { path: "/home/me/.codex/skills/grill", location: "codex", name: "grill", description: "x", id: null, attached: false, problem: "bundled-id" },
        { path: "/home/me/.claude/skills/away", location: "claude", name: null, description: null, id: null, attached: false, problem: "outside-location" },
      ],
    });
    renderPage();
    const discover = await screen.findByRole("region", { name: "Discover & install" });
    const found = await within(discover).findByRole("region", { name: "Found on this computer" });
    await within(found).findByRole("button", { name: "Attach Notes" });
    expect(within(found).getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Notes", "grill", "away"]);
    expect(within(found).getByRole("button", { name: "Attach Notes" })).toBeTruthy();
    expect(within(found).getByText("Its name is taken by a built-in extension.")).toBeTruthy();
    expect(within(found).getByText("It links to a place outside this folder, so Nema does not read it.")).toBeTruthy();
    expect(within(found).queryByRole("button", { name: "Attach grill" })).toBeNull();
    expect(within(found).queryByRole("button", { name: "Attach away" })).toBeNull();
    expect(hub.discoverExtensions).toHaveBeenCalledOnce();
  });

  it("attaching moves the skill into Installed, where it keeps Remove from list", async () => {
    vi.mocked(hub.discoverExtensions).mockResolvedValueOnce({ ...emptyDiscovery, skills: [notes] }).mockResolvedValue({ ...emptyDiscovery, skills: [{ ...notes, attached: true }] });
    vi.mocked(hub.attachExtension).mockResolvedValue(attachedNotes);
    renderPage();
    const attach = await screen.findByRole("button", { name: "Attach Notes" });
    await act(async () => fireEvent.click(attach));
    expect(hub.attachExtension).toHaveBeenCalledWith("/home/me/.claude/skills/notes");
    const installed = screen.getByRole("region", { name: "Installed" });
    const block = within(installed).getByRole("heading", { name: "Notes", level: 3 }).closest("section")!;
    expect(within(block).getByText("Found outside Nema")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Remove from list" })).toBeTruthy();
    // The found list is read again and now says the folder is attached.
    expect(await within(foundRegion()).findByText("Attached")).toBeTruthy();
    expect(within(foundRegion()).queryByRole("button", { name: "Attach Notes" })).toBeNull();
  });

  it("attaches a folder the person typed or chose, and explains a refusal in the page's language", async () => {
    vi.mocked(hub.pickDirectory).mockResolvedValue({ path: "/home/me/work/notes" });
    vi.mocked(hub.attachExtension).mockRejectedValueOnce(new Error("cannot attach /home/me/work/notes: id-taken")).mockResolvedValueOnce(attachedNotes);
    renderPage();
    const found = await screen.findByRole("region", { name: "Found on this computer" });
    expect(await within(found).findByText("No skill folders in /home/me/.claude/skills, /home/me/.codex/skills, /home/me/.agents/skills.")).toBeTruthy();
    const submit = within(found).getByRole("button", { name: "Attach folder" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => fireEvent.click(within(found).getByRole("button", { name: "Choose…" })));
    const input = within(found).getByRole("textbox", { name: "Another skill folder" }) as HTMLInputElement;
    expect(input.value).toBe("/home/me/work/notes");
    await act(async () => fireEvent.click(submit));
    expect(await within(found).findByText("Another extension already uses this id.")).toBeTruthy();
    // The path goes out exactly as typed: a folder name may end in a space.
    fireEvent.change(input, { target: { value: "/home/me/work/notes " } });
    await act(async () => fireEvent.click(submit));
    expect(hub.attachExtension).toHaveBeenLastCalledWith("/home/me/work/notes ");
    expect(input.value).toBe("");
    expect(within(screen.getByRole("region", { name: "Installed" })).getByRole("heading", { name: "Notes", level: 3 })).toBeTruthy();
  });

  it("Repair checks a bundled item that is not ready and shows the stored result", async () => {
    vi.mocked(hub.repairExtension)
      .mockResolvedValueOnce({ ...catalog[0]!, checkedAt: "2026-10-30T03:00:00.000Z" })
      .mockResolvedValueOnce({ ...catalog[0]!, availability: "ready", error: null, checkedAt: "2026-10-30T03:05:00.000Z" });
    renderPage();
    const graphify = (await screen.findByRole("heading", { name: "graphify", level: 3 })).closest("section")!;
    expect(within(graphify).getByText("The packaged Graphify runtime is missing. It can be repaired from here.")).toBeTruthy();
    await act(async () => fireEvent.click(within(graphify).getByRole("button", { name: "Repair" })));
    expect(hub.repairExtension).toHaveBeenCalledWith("code");
    expect(within(graphify).getByText(/still missing\. Reinstalling Nema puts it back/)).toBeTruthy();
    await act(async () => fireEvent.click(within(graphify).getByRole("button", { name: "Repair" })));
    expect(within(graphify).getByText("Checked: working.")).toBeTruthy();
    expect(within(graphify).getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(within(graphify).queryByText(/runtime is missing/)).toBeNull();
  });

  it("every bundled row has Check again, and a refused check shows its error without changing the row", async () => {
    vi.mocked(hub.repairExtension).mockRejectedValue(new Error("daemon 未连接"));
    renderPage();
    const github = (await screen.findByRole("heading", { name: "GitHub", level: 3 })).closest("section")!;
    await act(async () => fireEvent.click(within(github).getByRole("button", { name: "Check again" })));
    expect(await screen.findByText("daemon 未连接")).toBeTruthy();
    expect(within(github).queryByText("Checked: working.")).toBeNull();
    expect((within(github).getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the page's type filter and search narrow the found folders too", async () => {
    const lint = { path: "/home/me/.codex/skills/lint", location: "codex", name: "lint", description: "Checks style", id: "lint", attached: false, problem: null };
    vi.mocked(hub.discoverExtensions).mockResolvedValue({ ...emptyDiscovery, skills: [notes, lint] });
    renderPage();
    const found = await screen.findByRole("region", { name: "Found on this computer" });
    await within(found).findByRole("button", { name: "Attach Notes" });
    const search = screen.getByRole("searchbox", { name: "Search extensions" });
    fireEvent.change(search, { target: { value: "MEETING" } });
    expect(within(found).getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Notes"]);
    // A match that lives only among the found folders is a match, not "nothing matches".
    expect(screen.queryByText("No extensions match.")).toBeNull();
    fireEvent.change(search, { target: { value: "codex/skills" } });
    expect(within(found).getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["lint"]);
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(within(found).queryAllByRole("heading", { level: 4 })).toEqual([]);
    expect(within(found).getByText("No found folders match.")).toBeTruthy();
    expect(screen.getByText("No extensions match.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "MCP" }));
    expect(within(found).queryAllByRole("heading", { level: 4 })).toEqual([]);
    expect(within(found).getByText("No found folders match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    expect(within(found).getAllByRole("heading", { level: 4 })).toHaveLength(2);
  });

  it("the folder field waits for the extension list, so an attach cannot land before it", async () => {
    let finish: (rows: ExtensionRecord[]) => void = () => {};
    vi.mocked(hub.listExtensions).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPage();
    const found = await screen.findByRole("region", { name: "Found on this computer" });
    const input = within(found).getByRole("textbox", { name: "Another skill folder" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((within(found).getByRole("button", { name: "Choose…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(catalog));
    expect(input.disabled).toBe(false);
    expect((within(found).getByRole("button", { name: "Choose…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a location that could not be listed says so instead of reporting no folders", async () => {
    vi.mocked(hub.discoverExtensions).mockResolvedValue({
      ...emptyDiscovery,
      locations: [{ label: "claude", path: "/home/me/.claude/skills", found: true, unreadable: true }, ...emptyDiscovery.locations.slice(1)],
    });
    renderPage();
    const found = await screen.findByRole("region", { name: "Found on this computer" });
    expect(await within(found).findByText("Nema could not read /home/me/.claude/skills.")).toBeTruthy();
    expect(within(found).queryByText(/^No skill folders/)).toBeNull();
  });

  it("a found folder whose SKILL.md cannot be read says why", async () => {
    vi.mocked(hub.discoverExtensions).mockResolvedValue({
      ...emptyDiscovery,
      skills: [{ path: "/home/me/.claude/skills/locked", location: "claude", name: null, description: null, id: null, attached: false, problem: "unreadable" }],
    });
    renderPage();
    expect(await screen.findByText("SKILL.md could not be read.")).toBeTruthy();
  });

  it("a GitHub check explains a missing or signed-out GitHub CLI", async () => {
    vi.mocked(hub.repairExtension)
      .mockResolvedValueOnce({ ...catalog[1]!, availability: "missing-dependency", error: "github-cli-missing", checkedAt: "2026-10-30T03:00:00.000Z" })
      .mockResolvedValueOnce({ ...catalog[1]!, availability: "missing-dependency", error: "github-cli-signed-out", checkedAt: "2026-10-30T03:01:00.000Z" })
      .mockResolvedValueOnce({ ...catalog[1]!, availability: "damaged", error: "github-cli-damaged", checkedAt: "2026-10-30T03:02:00.000Z" });
    renderPage();
    const github = (await screen.findByRole("heading", { name: "GitHub", level: 3 })).closest("section")!;
    await act(async () => fireEvent.click(within(github).getByRole("button", { name: "Check again" })));
    expect(within(github).getByText("Checked: the GitHub CLI (gh) is not installed. Install it to use the GitHub tools.")).toBeTruthy();
    await act(async () => fireEvent.click(within(github).getByRole("button", { name: "Repair" })));
    expect(within(github).getByText("Checked: the GitHub CLI is not signed in to github.com. Run gh auth login, then check again.")).toBeTruthy();
    await act(async () => fireEvent.click(within(github).getByRole("button", { name: "Repair" })));
    expect(within(github).getByText("Checked: the GitHub CLI could not be asked for its status.")).toBeTruthy();
    expect(within(github).queryByText("Checked: working.")).toBeNull();
  });

  it("managed and external rows have no Repair button", async () => {
    vi.mocked(hub.listExtensions).mockResolvedValue([...catalog, attachedNotes]);
    renderPage();
    const block = (await screen.findByRole("heading", { name: "Notes", level: 3 })).closest("section")!;
    expect(within(block).queryByRole("button", { name: /Repair|Check again/ })).toBeNull();
  });

  it("adds an MCP server from Discover and shows its controls in the list", async () => {
    const mcpRow = row({
      id: "search", name: "Search", kind: "mcp", source: "mcp:stdio", revision: "abcdef123456", provision: "managed",
      mcp: { transport: "stdio", connection: "disconnected", server: null, tools: [], secrets: [{ name: "API_TOKEN", configured: false }], lastError: null },
    });
    vi.mocked(hub.saveMcpServer).mockResolvedValue(mcpRow);
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add an MCP server…" }));
    fireEvent.change(screen.getByLabelText("Id"), { target: { value: "search" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Search" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    vi.mocked(hub.listExtensions).mockResolvedValue([...catalog, mcpRow]);
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    const block = (await screen.findByRole("heading", { name: "Search" })).closest("section")!;
    expect(within(block).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(block).getByLabelText("New value for API_TOKEN")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save MCP server" })).toBeNull();
  });

  it("hides the MCP add button when filtering to skills", async () => {
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );
    expect(await screen.findByRole("button", { name: "Add an MCP server…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    expect(screen.queryByRole("button", { name: "Add an MCP server…" })).toBeNull();
  });

  it("a saved MCP server shows in the list even if the follow-up list read fails", async () => {
    const mcpRow = row({ id: "search", name: "Search", kind: "mcp", source: "mcp:stdio", revision: "abcdef123456", provision: "managed" });
    vi.mocked(hub.saveMcpServer).mockResolvedValue(mcpRow);
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add an MCP server…" }));
    fireEvent.change(screen.getByLabelText("Id"), { target: { value: "search" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Search" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Environment (NAME=value, NAME=secret:REF or NAME=env:VAR)"), { target: { value: "API_TOKEN=secret:API_TOKEN" } });
    vi.mocked(hub.listExtensions).mockRejectedValue(new Error("hub went away"));
    fireEvent.click(screen.getByRole("button", { name: "Save MCP server" }));
    const block = (await screen.findByRole("heading", { name: "Search" })).closest("section")!;
    expect(within(block).getByRole("button", { name: "Start" })).toBeTruthy();
    // The row has its credential slot from the saved config, without the list read.
    expect(within(block).getByLabelText("New value for API_TOKEN")).toBeTruthy();
    expect(within(block).getByText("Not set")).toBeTruthy();
  });
});

