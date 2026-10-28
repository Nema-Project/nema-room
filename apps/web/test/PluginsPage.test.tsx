import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRecord } from "@nema/shared";
import { PluginsPage } from "@/components/PluginsPage";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";

vi.mock("@/lib/hub", () => ({ listExtensions: vi.fn(), listPlugins: vi.fn() }));

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
