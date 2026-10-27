import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopTitlebar, showsCustomWindowButtons } from "@/components/DesktopTitlebar";
import { I18nProvider } from "@/lib/i18n";

vi.mock("next/image", () => ({
  default: () => null,
}));

type Controls = NonNullable<Window["nemaWindowControls"]>;

function installControls(options: { nativeTrafficLights?: boolean; fullScreen?: boolean } = {}): Controls {
  const controls = {
    nativeTrafficLights: options.nativeTrafficLights,
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ maximized: false, fullScreen: options.fullScreen === true })),
    onStateChanged: vi.fn(() => () => undefined),
  } as Controls;
  window.nemaWindowControls = controls;
  return controls;
}

function renderBar() {
  return render(<I18nProvider><DesktopTitlebar /></I18nProvider>);
}

afterEach(() => {
  delete window.nemaWindowControls;
  document.documentElement.classList.remove("nema-desktop-window");
});

describe("showsCustomWindowButtons", () => {
  it("hides custom buttons only when native traffic lights are enabled", () => {
    expect(showsCustomWindowButtons(undefined)).toBe(true);
    expect(showsCustomWindowButtons(false)).toBe(true);
    expect(showsCustomWindowButtons(true)).toBe(false);
  });
});

describe("DesktopTitlebar", () => {
  it("renders nothing in an ordinary browser", () => {
    renderBar();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(document.documentElement.classList.contains("nema-desktop-window")).toBe(false);
  });

  it("renders custom minimize, maximize, and close buttons when native traffic lights are off", () => {
    const controls = installControls({ nativeTrafficLights: false });
    renderBar();
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close window to tray" })).toBeTruthy();
    fireEvent.doubleClick(screen.getByRole("banner"));
    expect(controls.toggleMaximize).toHaveBeenCalledOnce();
    expect(screen.getByRole("banner").className).not.toContain("desktop-titlebar-macos");
  });

  it("does not render custom window buttons under macOS native traffic lights", () => {
    const controls = installControls({ nativeTrafficLights: true });
    renderBar();
    const bar = screen.getByRole("banner");
    expect(bar.className).toContain("desktop-titlebar-macos");
    expect(bar.className).not.toContain("desktop-titlebar-fullscreen");
    expect(screen.getByText("Nema Room")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close window to tray" })).toBeNull();
    fireEvent.doubleClick(bar);
    expect(controls.toggleMaximize).not.toHaveBeenCalled();
  });

  it("drops the traffic-light inset while the macOS window is fullscreen", async () => {
    installControls({ nativeTrafficLights: true, fullScreen: true });
    renderBar();
    await waitFor(() => {
      expect(screen.getByRole("banner").className).toContain("desktop-titlebar-fullscreen");
    });
    expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull();
  });
});
