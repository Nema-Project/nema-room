import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRecord } from "@nema/shared";
import { PluginsPage } from "@/components/PluginsPage";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";

vi.mock("@/lib/hub", () => ({ listExtensions: vi.fn(), listPlugins: vi.fn(), setExtensionUse: vi.fn(), removeExtension: vi.fn() }));

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
