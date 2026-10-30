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
}));

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
    const pdf = within(panel).getByText("pdf", { selector: "h3" }).closest("li")!;
    expect(within(pdf).getByText("Fill PDF forms")).toBeTruthy();
    expect(within(pdf).getByText("Installs to /home/me/.nema/extensions/extensions/pdf")).toBeTruthy();
    expect((within(pdf).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(false);
    const word = within(panel).getByText("Word", { selector: "h3" }).closest("li")!;
    expect(within(word).getByText("SKILL.md has no name and description, so it cannot be installed.")).toBeTruthy();
    expect(within(word).queryByRole("button", { name: "Install" })).toBeNull();
    const notes = within(panel).getByText("notes", { selector: "h3" }).closest("li")!;
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
    expect(await screen.findByRole("heading", { name: "pdf", level: 2 })).toBeTruthy();
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
    const block = (await screen.findByRole("heading", { name: "pdf", level: 2 })).closest("section")!;
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
    const block = (await screen.findByRole("heading", { name: "pdf", level: 2 })).closest("section")!;
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
    expect(await screen.findByRole("heading", { name: "pdf", level: 2 })).toBeTruthy();
    // The refresh started with the job answers last, with the list from before the install.
    await act(async () => first(catalog));
    expect(screen.getByRole("heading", { name: "pdf", level: 2 })).toBeTruthy();
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
    const block = (await screen.findByRole("heading", { name: "pdf", level: 2 })).closest("section")!;
    expect(await within(block).findByRole("button", { name: "Retry install" })).toBeTruthy();
  });
});
