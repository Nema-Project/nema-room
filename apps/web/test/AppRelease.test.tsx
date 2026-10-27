import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppReleaseBanner, AppReleaseFooter, resetAppReleaseForTests } from "@/components/AppRelease";
import { I18nProvider } from "@/lib/i18n";

const offer = { version: "0.2.0", url: "https://github.com/Nema-Project/nema-room/releases/tag/v0.2.0" };

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => body } as Response);
}

function installFetch(version: unknown, update: unknown, ok = true) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/_nema/version") return json(version, ok);
    if (url === "/_nema/update" && (!init?.method || init.method === "GET")) return json(update, ok);
    return json(update, ok);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRelease() {
  return render(
    <I18nProvider>
      <AppReleaseBanner />
      <AppReleaseFooter />
    </I18nProvider>,
  );
}

afterEach(() => {
  resetAppReleaseForTests();
  vi.unstubAllGlobals();
});

describe("AppRelease", () => {
  it("shows the version and short commit, and a release banner when a newer stable version exists", async () => {
    installFetch(
      { version: "0.1.3", commit: "abc1234" },
      { enabled: true, state: "newer", offer },
    );
    renderRelease();
    expect(await screen.findByText("Version 0.1.3 (abc1234)")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Update available: 0.2.0" });
    expect(link.getAttribute("href")).toBe(offer.url);
    expect((screen.getByRole("checkbox", { name: "Check for updates automatically" }) as HTMLInputElement).checked).toBe(true);
  });

  it("renders nothing when the desktop endpoint is unavailable", async () => {
    installFetch({}, {}, false);
    renderRelease();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Version/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows up to date only for a current check, and drops that line when a later check fails", async () => {
    const fetchMock = installFetch(
      { version: "0.1.3" },
      { enabled: true, state: "current" },
    );
    renderRelease();
    expect(await screen.findByText("You're up to date.")).toBeTruthy();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/_nema/version") return json({ version: "0.1.3" });
      return json({ enabled: true, state: "error" });
    });
    await waitFor(() => {
      window.dispatchEvent(new Event("focus"));
      expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    });
    await waitFor(() => expect(screen.queryByText("You're up to date.")).toBeNull());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("hides the banner when automatic checks are turned off", async () => {
    const fetchMock = installFetch(
      { version: "0.1.3" },
      { enabled: true, state: "newer", offer },
    );
    renderRelease();
    expect(await screen.findByRole("link", { name: "Update available: 0.2.0" })).toBeTruthy();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/_nema/version") return json({ version: "0.1.3" });
      if (init?.method === "PATCH") return json({ enabled: false, state: "disabled" });
      return json({ enabled: true, state: "newer", offer });
    });
    await userEvent.click(screen.getByRole("checkbox", { name: "Check for updates automatically" }));
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
    expect((screen.getByRole("checkbox", { name: "Check for updates automatically" }) as HTMLInputElement).checked).toBe(false);
  });

  it("saves the automatic-check setting and does not show a banner for an error", async () => {
    const fetchMock = installFetch(
      { version: "0.1.3" },
      { enabled: true, state: "error" },
    );
    renderRelease();
    const box = await screen.findByRole("checkbox", { name: "Check for updates automatically" });
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(box);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/_nema/update", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    })));
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/_nema/update/check", expect.objectContaining({ method: "POST" })));
  });
});
