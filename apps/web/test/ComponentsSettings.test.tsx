import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentsSettings, GraphifyEntry } from "@/components/ComponentsSettings";
import { DECLINED_KEY, formatMiB, refreshComponents, resetComponentsForTests, saveGraphifySettings, startGraphifyInstall } from "@/lib/components";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { ComponentStatus, ComponentView } from "@/lib/types";
import en from "../messages/en.json";
import ja from "../messages/ja.json";
import zh from "../messages/zh.json";

vi.mock("@/lib/hub", () => ({
  getComponents: vi.fn(),
  installComponent: vi.fn(),
  cancelComponentInstall: vi.fn(),
  updateComponentSettings: vi.fn(),
  getAgentClis: vi.fn(),
}));

const LOCK_HASH = "c".repeat(64);

/** A fixture lock target in the shape of scripts/desktop/graphify-lock.json; the offer's size is its sum. */
const FIXTURE_LOCK_TARGET = {
  python: { file: "cpython-3.11.18+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz", size: 31_457_280 },
  wheels: [
    { file: "graphifyy-0.9.95-py3-none-any.whl", size: 1_048_576 },
    { file: "networkx-3.6.1-py3-none-any.whl", size: 2_097_152 },
    { file: "tree_sitter-0.25.2-cp311-cp311-manylinux_2_17_x86_64.whl", size: 655_360 },
  ],
};
const LOCK_TOTAL = [FIXTURE_LOCK_TARGET.python, ...FIXTURE_LOCK_TARGET.wheels].reduce((sum, entry) => sum + entry.size, 0);

type StatusInput = { state: ComponentStatus["state"] } & Record<string, unknown>;

function view(status: StatusInput, extra: Partial<ComponentView> = {}): ComponentView {
  return {
    name: "graphify",
    status: { name: "graphify", lockHash: LOCK_HASH, ...status } as unknown as ComponentStatus,
    offer: { lockHash: LOCK_HASH, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["github.com", "files.pythonhosted.org"] },
    settings: {
      pythonMirror: { value: null, source: null, config: null },
      pypiBase: { value: null, source: null, config: null },
      offline: { value: false, source: null, config: false },
    },
    ...extra,
  };
}

const failed = (reason: string, detail = "boom") => view({ state: "failed", reason, detail, at: "2026-11-18T00:00:00.000Z" });

function answer(next: ComponentView) {
  vi.mocked(hub.getComponents).mockResolvedValue({ components: [next] });
}

const statusCalls = () => vi.mocked(hub.getComponents).mock.calls.length;

/** Waits until a graph action's status read has happened and its answer has been handled. */
async function settleAfter(before: number) {
  await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderEntry(signal = 0) {
  const tree = (next: number) => (
    <I18nProvider>
      <GraphifyEntry offerSignal={next} />
      <p>Other workspace content</p>
    </I18nProvider>
  );
  const result = render(tree(signal));
  return { ...result, signal: (next: number) => result.rerender(tree(next)) };
}

beforeEach(() => {
  localStorage.clear();
  resetComponentsForTests();
  vi.mocked(hub.getComponents).mockReset();
  vi.mocked(hub.installComponent).mockReset();
  vi.mocked(hub.cancelComponentInstall).mockReset();
  vi.mocked(hub.updateComponentSettings).mockReset();
  vi.mocked(hub.getAgentClis).mockReset();
  vi.mocked(hub.getAgentClis).mockResolvedValue({ agents: [] });
});

afterEach(() => {
  resetComponentsForTests();
});

describe("graph entry and first-use offer", () => {
  it("shows not-installed with an install button and never opens the offer just by being shown", async () => {
    answer(view({ state: "not-installed" }));
    renderEntry();
    expect(await screen.findByText("Graphify is not installed. Repository indexing and code search need it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hub.installComponent).not.toHaveBeenCalled();
  });

  it("opens the offer on a graph action with the component, the lock's summed size, the location and the hosts", async () => {
    answer(view({ state: "not-installed" }));
    const { signal } = renderEntry();
    await screen.findByRole("button", { name: "Install" });
    signal(1);
    const dialog = await screen.findByRole("dialog", { name: "Download Graphify?" });
    expect(within(dialog).getByText("Graphify (code knowledge graph)")).toBeTruthy();
    expect(LOCK_TOTAL).toBe(35_258_368);
    expect(within(dialog).getByTestId("component-offer-size").textContent).toBe("33.6 MiB");
    expect(within(dialog).getByTestId("component-offer-size").textContent).toBe(formatMiB(LOCK_TOTAL));
    expect(within(dialog).getByText("/home/u/.nema/runtime/graphify/")).toBeTruthy();
    expect(within(dialog).getByText("github.com, files.pythonhosted.org")).toBeTruthy();
    expect(hub.installComponent).not.toHaveBeenCalled();
  });

  it("a decline is remembered for this lock: later graph actions do not prompt again, the install button still does", async () => {
    answer(view({ state: "not-installed" }));
    const { signal } = renderEntry();
    await screen.findByRole("button", { name: "Install" });
    signal(1);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(DECLINED_KEY)).toBe(LOCK_HASH);
    const before = statusCalls();
    signal(2);
    await settleAfter(before);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Graphify is not installed. Repository indexing and code search need it.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("dialog", { name: "Download Graphify?" })).toBeTruthy();
    expect(hub.installComponent).not.toHaveBeenCalled();
  });

  it("a new lock (another version) is offered again after an older decline, and the old one reads as turned off", async () => {
    localStorage.setItem(DECLINED_KEY, "d".repeat(64));
    answer(view({ state: "lock-mismatch", installedLockHash: "d".repeat(64) }));
    const { signal } = renderEntry();
    expect(await screen.findByText(/made for another version of Nema and is turned off/)).toBeTruthy();
    signal(1);
    expect(await screen.findByRole("dialog", { name: "Download Graphify?" })).toBeTruthy();
  });

  it("discards a status response that predates an install and re-fetches the fresh state", async () => {
    const progress = { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null };
    const installing = view({ state: "installing", progress });
    // The first GET starts before the install and answers after it.
    let resolveStale!: (value: { components: ComponentView[] }) => void;
    const stale = new Promise<{ components: ComponentView[] }>((resolve) => {
      resolveStale = resolve;
    });
    vi.mocked(hub.getComponents).mockReturnValueOnce(stale);
    const first = refreshComponents();
    vi.mocked(hub.installComponent).mockResolvedValue(installing);
    const started = startGraphifyInstall(LOCK_HASH);
    // The re-fetch after the stale answer sees the install running.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [installing] });
    resolveStale({ components: [view({ state: "not-installed" })] });
    await started;
    const result = await first;
    expect(result.graphify?.status.state).toBe("installing");
    expect(statusCalls()).toBeGreaterThanOrEqual(2);
  });

  it("a retry GET that captured not-installed before the daemon started the install is discarded once the install is accepted", async () => {
    const progress = { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null };
    const installing = view({ state: "installing", progress });
    // GET1 starts before the install; the retry GET2 starts after GET1 is discarded and is answered
    // by the daemon before the daemon registers the install.
    let resolveGet1!: (value: { components: ComponentView[] }) => void;
    let resolveGet2!: (value: { components: ComponentView[] }) => void;
    const get1 = new Promise<{ components: ComponentView[] }>((resolve) => {
      resolveGet1 = resolve;
    });
    const get2 = new Promise<{ components: ComponentView[] }>((resolve) => {
      resolveGet2 = resolve;
    });
    vi.mocked(hub.getComponents).mockReturnValueOnce(get1).mockReturnValueOnce(get2);
    const first = refreshComponents();
    let resolveInstall!: (value: ComponentView) => void;
    const installStarted = new Promise<ComponentView>((resolve) => {
      resolveInstall = resolve;
    });
    vi.mocked(hub.installComponent).mockReturnValue(installStarted);
    const started = startGraphifyInstall(LOCK_HASH);
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [installing] });
    resolveGet1({ components: [view({ state: "not-installed" })] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusCalls()).toBe(2);
    // The POST resolves: installing is accepted.
    resolveInstall(installing);
    await started;
    // A poll joins the in-flight retry GET2; it answers the pre-install state, so it is discarded
    // and the fresh fetch reports the install running.
    const polled = refreshComponents();
    resolveGet2({ components: [view({ state: "not-installed" })] });
    const result = await polled;
    expect(result.graphify?.status.state).toBe("installing");
    expect(statusCalls()).toBe(3);
    await first;
  });

  it("confirming sends the offered lock-hash, then shows progress with the current file and a cancel", async () => {
    answer(view({ state: "not-installed" }));
    const progress = { phase: "download", downloadedBytes: 10 * 1024 * 1024, totalBytes: LOCK_TOTAL, file: FIXTURE_LOCK_TARGET.python.file };
    const installing = view({ state: "installing", progress });
    vi.mocked(hub.installComponent).mockResolvedValue(installing);
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue(view({ state: "not-installed" }));
    renderEntry();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    answer(installing);
    await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH);
    const dialog = await screen.findByRole("dialog", { name: "Installing Graphify" });
    expect(within(dialog).getByRole("status").textContent).toContain("10.0 MiB of 33.6 MiB");
    expect(within(dialog).getByText(`Current file: ${FIXTURE_LOCK_TARGET.python.file}`)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    expect(hub.cancelComponentInstall).toHaveBeenCalledWith("graphify");
  });

  it("retrying a cancelled repair from the progress dialog sends a forced repair", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    // A repair started elsewhere is already running; this dialog only follows it (force=false).
    answer(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue({ ...installed, cancelled: true });
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    renderEntry();
    await userEvent.click(await screen.findByRole("button", { name: "Show progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Installing Graphify" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    expect(await within(dialog).findByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    // Over an installed copy only a forced install is a retry of the repair.
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH, true);
  });

  it("settings saves are serialized, so a slower earlier save cannot publish over a later one", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const first = deferred<ComponentView>();
    const second = deferred<ComponentView>();
    const mirrorView = view({ state: "not-installed" });
    const offlineView = { ...view({ state: "not-installed" }), settings: { ...view({ state: "not-installed" }).settings, offline: { value: true, source: "config" as const, config: true } } };
    vi.mocked(hub.updateComponentSettings).mockImplementation((_name, patch) => (patch.offline === true ? second.promise : first.promise));
    const save1 = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    const save2 = saveGraphifySettings({ offline: true });
    // The second save is not even sent until the first answer arrives.
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    first.resolve(mirrorView);
    await save1;
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(2);
    second.resolve(offlineView);
    await save2;
    answer(offlineView);
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.settings.offline.value).toBe(true);
  });

  it("a failure greys only the graph entry, names the cause, and offers retry and import without a global error", async () => {
    answer(failed("network", "connect ECONNREFUSED"));
    const { container } = renderEntry();
    expect(await screen.findByText("Graphify is not installed (last attempt failed: network error).")).toBeTruthy();
    const entry = container.querySelector(".component-entry");
    expect(entry?.classList.contains("unavailable")).toBe(true);
    expect(entry?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Other workspace content")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Import offline pack" }));
    expect(screen.getByText("nema components import <file>")).toBeTruthy();
  });

  it("writes network, proxy and checksum failures differently", async () => {
    const texts: string[] = [];
    for (const reason of ["network", "proxy", "hash-mismatch"]) {
      resetComponentsForTests();
      answer(failed(reason));
      const { unmount } = renderEntry();
      texts.push((await screen.findByText(/last attempt failed/)).textContent ?? "");
      unmount();
    }
    expect(texts).toEqual([
      "Graphify is not installed (last attempt failed: network error).",
      "Graphify is not installed (last attempt failed: proxy error).",
      "Graphify is not installed (last attempt failed: a downloaded file does not match the pinned checksum).",
    ]);
  });

  it("retry asks again before a new download", async () => {
    answer(failed("proxy", "407 Proxy Authentication Required"));
    renderEntry();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("dialog", { name: "Download Graphify?" })).toBeTruthy();
    expect(hub.installComponent).not.toHaveBeenCalled();
  });

  it("offline mode offers import only and never opens the offer on a graph action", async () => {
    answer(failed("offline", "Downloads are turned off"));
    const { signal } = renderEntry();
    expect(await screen.findByText(/component downloads are turned off \(offline mode\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import offline pack" })).toBeTruthy();
    const before = statusCalls();
    signal(1);
    await settleAfter(before);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an unreachable daemon is a quiet line, not an alert", async () => {
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("daemon 未连接"));
    renderEntry();
    expect(await screen.findByText("Component status is unavailable: daemon 未连接")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Settings → Components", () => {
  function renderSettings() {
    return render(
      <I18nProvider>
        <ComponentsSettings />
      </I18nProvider>,
    );
  }

  it("shows the installed version and the agent CLI check with official links, without installing anything", async () => {
    answer(view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" }));
    vi.mocked(hub.getAgentClis).mockResolvedValue({
      agents: [
        { id: "codex", command: "codex", installed: false, version: null, installUrl: "https://developers.openai.com/codex/cli" },
        { id: "claude-code", command: "claude", installed: true, version: "2.1.400 (Claude Code)", installUrl: "https://code.claude.com/docs/en/setup" },
      ],
    });
    renderSettings();
    expect(await screen.findByText("Installed: Graphify 0.9.95 (Python 3.11.18).")).toBeTruthy();
    expect(await screen.findByText("Installed: 2.1.400 (Claude Code)")).toBeTruthy();
    expect(screen.getByText(/codex was not found on PATH/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "official install instructions" }).getAttribute("href")).toBe("https://developers.openai.com/codex/cli");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(hub.installComponent).not.toHaveBeenCalled();
  });

  it("saves the mirror fields to the daemon config and shows an environment variable's value as winning", async () => {
    const base = view({ state: "not-installed" });
    answer({ ...base, settings: { ...base.settings, pypiBase: { value: "https://env.example", source: "env", config: "https://saved.example" } } });
    vi.mocked(hub.updateComponentSettings).mockResolvedValue(base);
    renderSettings();
    const python = await screen.findByLabelText("Python build mirror");
    const pypi = screen.getByLabelText("PyPI files mirror") as HTMLInputElement;
    expect(pypi.disabled).toBe(true);
    expect(pypi.value).toBe("https://saved.example");
    expect(screen.getByText("Set by NEMA_GRAPHIFY_PYPI_BASE: https://env.example. The saved value is not used while the variable is set.")).toBeTruthy();
    await userEvent.type(python, "https://mirror.example/python");
    await userEvent.click(screen.getByRole("button", { name: "Save mirrors" }));
    expect(hub.updateComponentSettings).toHaveBeenCalledWith("graphify", { pythonMirror: "https://mirror.example/python", pypiBase: "https://saved.example" });
  });

  it("the settings entry opens the same offer", async () => {
    answer(view({ state: "not-installed" }));
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("dialog", { name: "Download Graphify?" });
    expect(within(dialog).getByTestId("component-offer-size").textContent).toBe("33.6 MiB");
  });

  it("a failed repair shows the failure with the installed version and offers another try", async () => {
    const installed = view({
      state: "installed",
      version: { graphifyy: "0.9.95", python: "3.11.18" },
      path: "/p",
      launcher: "/p/graphify",
      lastFailure: { reason: "self-check", detail: "injected", at: "2026-11-18T00:00:00.000Z" },
    });
    answer(installed);
    vi.mocked(hub.installComponent).mockResolvedValue(installed);
    renderSettings();
    expect(await screen.findByText("Installed: Graphify 0.9.95 (Python 3.11.18). The last reinstall failed: the installed component failed its self-check.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH, true);
    // The repair failed again: the dialog says so and offers another try instead of "installed".
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The last reinstall failed: the installed component failed its self-check.");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(dialog).queryByText("Graphify is installed. Graph features are ready.")).toBeNull();
  });

  it("offline mode offers no reinstall for an installed component", async () => {
    const base = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    answer({ ...base, settings: { ...base.settings, offline: { value: true, source: "env", config: false } } });
    renderSettings();
    expect(await screen.findByText("Installed: Graphify 0.9.95 (Python 3.11.18).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reinstall" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    // Import is the one repair path left while downloads are off, so it stays.
    expect(screen.getByRole("button", { name: "Import offline pack" })).toBeTruthy();
  });

  it("cancelling a repair reports the cancel instead of calling the old copy ready", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue({ ...installed, cancelled: true });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH, true);
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    expect(hub.cancelComponentInstall).toHaveBeenCalledWith("graphify");
    expect(await within(dialog).findByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    expect(within(dialog).queryByText("Graphify is installed. Graph features are ready.")).toBeNull();
  });

  it("a cancel that landed after the repair completed shows the finished install", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue({ ...installed, cancelled: false });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    expect(await within(dialog).findByText("Graphify is installed. Graph features are ready.")).toBeTruthy();
    expect(within(dialog).queryByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeNull();
  });

  it("a repair failure recorded during the attempt arrives through a later status read", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const failedRepair = view({
      state: "installed",
      version: { graphifyy: "0.9.95", python: "3.11.18" },
      path: "/p",
      launcher: "/p/graphify",
      lastFailure: { reason: "network", detail: "connect ECONNREFUSED", at: "2026-11-18T00:00:00.000Z" },
    });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH, true);
    // The attempt's own failure is not in the POST answer; the next status read carries it.
    answer(failedRepair);
    await refreshComponents();
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The last reinstall failed: network error.");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a confirmed cancellation is shown before a previous repair failure", async () => {
    const withFailure = view({
      state: "installed",
      version: { graphifyy: "0.9.95", python: "3.11.18" },
      path: "/p",
      launcher: "/p/graphify",
      lastFailure: { reason: "network", detail: "connect ECONNREFUSED", at: "2026-11-18T00:00:00.000Z" },
    });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(withFailure);
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue({ ...withFailure, cancelled: true });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    // The retry was cancelled; the older failure stays in the status row but is not this outcome.
    expect(await within(dialog).findByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("a cancel answer without an outcome shows the status, not a completion", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    // No `cancelled` field: another client stopped the job first, so this dialog cannot know.
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue(installed);
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    expect(await within(dialog).findByText("Installed: Graphify 0.9.95 (Python 3.11.18).")).toBeTruthy();
    expect(within(dialog).queryByText("Graphify is installed. Graph features are ready.")).toBeNull();
    expect(within(dialog).queryByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeNull();
  });

  it("a rejected retry from the cancelled panel keeps the cancellation and shows the error", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockRejectedValue(new Error("hub unreachable"));
    vi.mocked(hub.installComponent).mockResolvedValueOnce(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue({ ...installed, cancelled: true });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    expect(await within(dialog).findByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    // The retry never started: the panel stays the cancelled one and carries the error.
    expect((await within(dialog).findByRole("alert")).textContent).toContain("hub unreachable");
    expect(within(dialog).getByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    expect(within(dialog).queryByText("Graphify is installed. Graph features are ready.")).toBeNull();
  });

  it("a rejected retry from the unknown-outcome panel keeps the status and shows the error", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockRejectedValue(new Error("hub unreachable"));
    vi.mocked(hub.installComponent).mockResolvedValueOnce(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockResolvedValue(installed);
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    expect(await within(dialog).findByText("Installed: Graphify 0.9.95 (Python 3.11.18).")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("hub unreachable");
    expect(within(dialog).getByText("Installed: Graphify 0.9.95 (Python 3.11.18).")).toBeTruthy();
    expect(within(dialog).queryByText("Graphify is installed. Graph features are ready.")).toBeNull();
  });
});

describe("component copy", () => {
  it("has every component key in all three languages, with distinct failure causes", () => {
    const keys = (messages: Record<string, string>) => Object.keys(messages).filter((key) => key.startsWith("components.") || key === "appSettings.tab.components").sort();
    expect(keys(en).length).toBeGreaterThan(50);
    expect(keys(zh)).toEqual(keys(en));
    expect(keys(ja)).toEqual(keys(en));
    const reasons = ["components.reason.network", "components.reason.proxy", "components.reason.hashMismatch"] as const;
    for (const messages of [en, zh, ja] as Array<Record<string, string>>) {
      expect(new Set(reasons.map((key) => messages[key])).size).toBe(3);
    }
  });
});
