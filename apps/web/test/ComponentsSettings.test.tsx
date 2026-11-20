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
    // A live store subscriber: the settings section's offline toggle reads the published
    // snapshot, so what it shows is what the saves published — no GET involved.
    render(
      <I18nProvider>
        <ComponentsSettings />
      </I18nProvider>,
    );
    const offlineToggle = (await screen.findByRole("checkbox", { name: en["components.offline"] })) as HTMLInputElement;
    expect(offlineToggle.checked).toBe(false);
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
    // The second PATCH response itself published the settings: the toggle shows offline mode
    // with no refresh in between, while the GET fixture still returns the pre-save view.
    await waitFor(() => expect(offlineToggle.checked).toBe(true));
  });

  it("a settings answer that lands after an install started keeps the install state and takes the settings", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // The install starts and publishes its state while the PATCH is still in flight.
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing" }));
    await startGraphifyInstall(LOCK_HASH);
    // The settings answer was composed before the install started: its lifecycle state is
    // stale, but its settings — and the offer those settings imply, since the mirror moved
    // the download hosts — are the ones the person just saved.
    const stale = view({ state: "not-installed" });
    const staleOffer = stale.offer ?? { lockHash: LOCK_HASH, totalBytes: LOCK_TOTAL, location: "", hosts: [] };
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
      offer: { ...staleOffer, hosts: ["mirror.example"] },
    });
    await save;
    // Read the published snapshot back without a successful GET overwriting it either way:
    // a failed refresh keeps the current view and only records the error.
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.status.state).toBe("installing");
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
    expect(snapshot.graphify?.offer?.hosts).toEqual(["mirror.example"]);
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

  it("turning offline mode off in settings shows the fresh status instead of the old offline failure", async () => {
    const offline = view({ state: "failed", reason: "offline", detail: "Downloads are turned off", at: "2026-11-18T00:00:00.000Z" });
    answer({ ...offline, settings: { ...offline.settings, offline: { value: true, source: "config" as const, config: true } } });
    await refreshComponents();
    // The save turns offline mode off; the daemon's answer carries the fresh status.
    const fresh = view({ state: "not-installed" });
    vi.mocked(hub.updateComponentSettings).mockResolvedValue(fresh);
    await saveGraphifySettings({ offline: false });
    // Read the published snapshot back without a successful GET overwriting it either way:
    // a failed refresh keeps the current view and only records the error.
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.status.state).toBe("not-installed");
    expect(snapshot.graphify?.settings.offline.value).toBe(false);
  });

  it("a settings answer that lands after a poll published the install's outcome keeps the polled status", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    // The install starts before the save is sent: the mutation epoch it moves cannot mask
    // the status guard, which must be the only thing preserving the polled outcome.
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing" }));
    await startGraphifyInstall(LOCK_HASH);
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // A poll publishes the installed outcome before the settings answer arrives.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [installed] });
    await refreshComponents();
    // The settings answer was composed while the install was running: its lifecycle
    // state is stale, but its settings are the ones the person just saved.
    const stale = view({ state: "installing" });
    const staleOffer = stale.offer ?? { lockHash: LOCK_HASH, totalBytes: LOCK_TOTAL, location: "", hosts: [] };
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
      offer: { ...staleOffer, hosts: ["mirror.example"] },
    });
    await save;
    // Read the published snapshot back without a successful GET overwriting it either way.
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.status.state).toBe("installed");
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
    expect(snapshot.graphify?.offer?.hosts).toEqual(["mirror.example"]);
  });

  it("a settings answer does not restore a stale installing state a same-state poll already replaced", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // Another client started and cancelled an install while the PATCH was in flight; a
    // poll publishes the same not-installed state the snapshot already had — a fresh
    // observation all the same, so it must invalidate the PATCH's stale installing.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [view({ state: "not-installed" })] });
    await refreshComponents();
    const stale = view({ state: "installing" });
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    await save;
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.status.state).toBe("not-installed");
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
  });

  it("a settings answer does not restore an older offer after the lock changed", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // An install for a newer lock publishes its offer while the PATCH is in flight.
    const newHash = "d".repeat(64);
    const newer = view({ state: "installing", progress: { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null } }, { offer: { lockHash: newHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    vi.mocked(hub.installComponent).mockResolvedValue(newer);
    await startGraphifyInstall(newHash);
    // The settings answer carries the older offer; the save refreshes and takes the
    // fresh read's newer offer instead of restoring the older one.
    const stale = view({ state: "not-installed" });
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [newer] });
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    await save;
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.offer?.lockHash).toBe(newHash);
    expect(snapshot.graphify?.offer?.hosts).toEqual(["new.example"]);
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
    expect(snapshot.graphify?.status.state).toBe("installing");
  });

  it("a settings answer whose offer conflicts with a newer one takes the fresh read's offer", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // An install for a newer lock publishes its offer while the PATCH is in flight.
    const newHash = "d".repeat(64);
    const newer = view({ state: "installing", progress: { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null } }, { offer: { lockHash: newHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    vi.mocked(hub.installComponent).mockResolvedValue(newer);
    await startGraphifyInstall(newHash);
    // The settings answer carries the older offer: neither it nor the published one is
    // provably current, so the save refreshes and takes the read's offer.
    const stale = view({ state: "not-installed" });
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    // The fresh read returns a third offer: the daemon's current one, not the answer's
    // older one or the published newer one.
    const freshHash = "e".repeat(64);
    const fresh = view({ state: "not-installed" }, { offer: { lockHash: freshHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["fresh.example"] } });
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [fresh] });
    await save;
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.offer?.lockHash).toBe(freshHash);
    expect(snapshot.graphify?.offer?.hosts).toEqual(["fresh.example"]);
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
    expect(snapshot.graphify?.status.state).toBe("not-installed");
  });

  it("a settings answer with no offer takes the fresh read's offer and error", async () => {
    // A terminal state, so no poll runs: the refresh must happen explicitly.
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    // The answer carries no offer and a new offer error (the lock is unreadable).
    const stale = view({ state: "not-installed" });
    resolveSettings({
      ...stale,
      offer: null,
      offerError: "the lock file is corrupt",
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    // The fresh read confirms there is no offer and carries the same error.
    const fresh = view({ state: "not-installed" }, { offer: null, offerError: "the lock file is corrupt" });
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [fresh] });
    await save;
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.offer).toBeNull();
    expect(snapshot.graphify?.offerError).toBe("the lock file is corrupt");
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
  });

  it("a settings answer does not keep a delayed not-installed publication over an active install", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    // Another client starts an install: the PATCH captures installing.
    const progress = { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null };
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    await startGraphifyInstall(LOCK_HASH);
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // A GET that captured not-installed before the install started publishes late: its
    // response is the daemon's older observation, and the page must not keep it over the
    // active install.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [view({ state: "not-installed" })] });
    await refreshComponents();
    // The settings answer carries the installing state the PATCH captured.
    const stale = view({ state: "installing" });
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    // The save reconciles with a fresh read: the daemon's current state is installing, and
    // the poll resumes from it.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [view({ state: "installing" })] });
    await save;
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.status.state).toBe("installing");
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
  });

  it("a settings answer does not restore an older offer when the fresh read's offer changed", async () => {
    answer(view({ state: "not-installed" }));
    await refreshComponents();
    // Another client starts an install: the PATCH captures installing with the current offer.
    const progress = { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null };
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    await startGraphifyInstall(LOCK_HASH);
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // A delayed GET publishes not-installed with the same (older) offer, so the save
    // reconciles against a fresh read.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [view({ state: "not-installed" })] });
    await refreshComponents();
    // The settings answer carries installing with the older offer: the published and answer
    // offers agree, but the lock changed again while the PATCH was in flight, so the fresh
    // read's offer is the newer lock and must decide.
    const stale = view({ state: "installing", progress });
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    const newHash = "d".repeat(64);
    const freshView = view({ state: "installing", progress }, { offer: { lockHash: newHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [freshView] });
    await save;
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const snapshot = await refreshComponents();
    expect(snapshot.graphify?.offer?.lockHash).toBe(newHash);
    expect(snapshot.graphify?.status.state).toBe("installing");
    expect(snapshot.graphify?.settings.pythonMirror.value).toBe("https://mirror.example");
  });

  it("a failed conflict refresh keeps the error visible and blocks confirmation until a fresh read succeeds", async () => {
    // A terminal state, so no poll runs: the refresh must happen explicitly.
    answer(view({ state: "not-installed" }));
    const progress = { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null };
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    renderSettings();
    await screen.findByRole("button", { name: "Install" });
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    // The settings answer carries a different offer (the lock changed while the PATCH was in
    // flight): the save refreshes to decide, and the refresh fails.
    const stale = view({ state: "not-installed" }, { offer: { lockHash: "d".repeat(64), totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    await save;
    // The settings page shows the refresh's error beside the published (unverified) offer.
    expect(await screen.findByText("Component status is unavailable: hub unreachable")).toBeTruthy();
    // The dialog will not confirm the unverified offer until a fresh read succeeds.
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("dialog", { name: "Download Graphify?" });
    const confirm = within(dialog).getByRole("button", { name: "Download and install" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(hub.installComponent).not.toHaveBeenCalled();
    // A fresh read succeeds: the error clears and confirmation is available again.
    answer(view({ state: "not-installed" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Download and install" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH);
  });

  it("a failed conflict refresh while the dialog follows an install keeps the failed panel's Retry from confirming the unverified offer", async () => {
    answer(view({ state: "not-installed" }));
    const progress = { phase: "download", downloadedBytes: 0, totalBytes: LOCK_TOTAL, file: null };
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("dialog", { name: "Download Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH);
    vi.mocked(hub.installComponent).mockClear();
    // The install the dialog is following fails: the poll publishes the failure.
    answer(failed("network"));
    await refreshComponents();
    // A settings save whose answer carries a different offer refreshes to decide, and the
    // refresh fails: the snapshot keeps the failed status and gains the error.
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    const stale = { ...failed("network"), offer: { lockHash: "d".repeat(64), totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } };
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    await save;
    // The failed panel shows the refresh error, and its Retry goes to the confirm step
    // instead of confirming the unverified offer directly.
    expect(within(dialog).getByText("Component status is unavailable: hub unreachable")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(hub.installComponent).not.toHaveBeenCalled();
    const confirmButton = within(dialog).getByRole("button", { name: "Download and install" });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    // A fresh read succeeds: the error clears and confirmation is available again.
    answer(failed("network"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Download and install" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH);
  });

  it("queueing a second save does not invalidate the first save's answer", async () => {
    const offline = view({ state: "failed", reason: "offline", detail: "Downloads are turned off", at: "2026-11-18T00:00:00.000Z" });
    answer({ ...offline, settings: { ...offline.settings, offline: { value: true, source: "config" as const, config: true } } });
    await refreshComponents();
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const first = deferred<ComponentView>();
    vi.mocked(hub.updateComponentSettings).mockImplementationOnce(() => first.promise);
    vi.mocked(hub.updateComponentSettings).mockRejectedValueOnce(new Error("hub unreachable"));
    const save1 = saveGraphifySettings({ offline: false });
    const save2 = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    // The second save is queued, not sent: queueing it must not invalidate the first
    // save's answer.
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    const fresh = view({ state: "not-installed" });
    first.resolve(fresh);
    await save1;
    // The first answer published the fresh status even though a second save was queued.
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    const afterFirst = await refreshComponents();
    expect(afterFirst.graphify?.status.state).toBe("not-installed");
    // The second save is sent now and fails; nothing republishes the old offline failure.
    await expect(save2).rejects.toThrow("hub unreachable");
    const afterSecond = await refreshComponents();
    expect(afterSecond.graphify?.status.state).toBe("not-installed");
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

  it("an installed repair with a failed refresh shows the snapshot error in the repair panel and does not retry directly", async () => {
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
    vi.mocked(hub.installComponent).mockClear();
    // The repair failed again: the dialog shows the repair panel.
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The last reinstall failed");
    // A settings save whose answer carries a different offer refreshes to decide, and the
    // refresh fails: the snapshot keeps the installed status and gains the error.
    let resolveSettings!: (value: ComponentView) => void;
    vi.mocked(hub.updateComponentSettings).mockImplementation(
      () =>
        new Promise<ComponentView>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const save = saveGraphifySettings({ pythonMirror: "https://mirror.example" });
    await Promise.resolve();
    expect(hub.updateComponentSettings).toHaveBeenCalledTimes(1);
    const stale = { ...installed, offer: { lockHash: "d".repeat(64), totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } };
    resolveSettings({
      ...stale,
      settings: { ...stale.settings, pythonMirror: { value: "https://mirror.example", source: "config" as const, config: "https://mirror.example" } },
    });
    vi.mocked(hub.getComponents).mockRejectedValue(new Error("hub unreachable"));
    await save;
    // The repair panel shows the refresh error, and its Retry goes to the confirm step
    // instead of retrying the unverified offer directly.
    expect(within(dialog).getByText("Component status is unavailable: hub unreachable")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(hub.installComponent).not.toHaveBeenCalled();
    const confirmButton = within(dialog).getByRole("button", { name: "Download and install" });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    // A fresh read succeeds: the error clears and confirmation is available again.
    answer(installed);
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Download and install" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH, true);
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

  it("a failed cancellation followed by a successful retry shows no error next to the cancel", async () => {
    const installed = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" });
    const progress = { phase: "download", downloadedBytes: 10, totalBytes: LOCK_TOTAL, file: null };
    answer(installed);
    vi.mocked(hub.installComponent).mockResolvedValue(view({ state: "installing", progress }));
    vi.mocked(hub.cancelComponentInstall).mockRejectedValueOnce(new Error("hub unreachable"));
    vi.mocked(hub.cancelComponentInstall).mockImplementation(async () => {
      // The cancel succeeded: a poll after this must read installed, not the installing
      // view a poll scheduled before the cancel would otherwise republish.
      vi.mocked(hub.getComponents).mockResolvedValue({ components: [installed] });
      return { ...installed, cancelled: true };
    });
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    // A poll during the test must not flip the dialog to installed: the GET mock returns
    // the installing view from before the install click until the cancel succeeds.
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [view({ state: "installing", progress })] });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    // The first cancel fails: its error is shown.
    await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel download" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("hub unreachable");
    // The retry succeeds: the cancel is reported, and the first attempt's error is gone.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    expect(await within(dialog).findByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
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

  it("an offer-changed failure shows the replacement offer before the retry downloads anything", async () => {
    answer(view({ state: "not-installed" }));
    // The install the person confirmed is refused because the lock moved meanwhile: the
    // attempt's answer is the offer-changed failure, carrying the replacement offer.
    vi.mocked(hub.installComponent).mockResolvedValue(failed("offer-changed", "The component offer changed after it was shown; nothing was downloaded."));
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("dialog", { name: "Download Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledTimes(1);
    // The follow step shows the failure — and its Retry must not submit the replacement
    // offer sight unseen: it goes back to the confirmation panel, and nothing more is sent.
    expect((await within(dialog).findByRole("alert")).textContent).toContain("the component offer changed; confirm again");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(hub.installComponent).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByTestId("component-offer-size").textContent).toContain(formatMiB(LOCK_TOTAL));
    // Confirming the shown offer is what starts the next download.
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await waitFor(() => expect(hub.installComponent).toHaveBeenCalledTimes(2));
    expect(hub.installComponent).toHaveBeenLastCalledWith("graphify", LOCK_HASH);
  });
  it("a retry after a failure for a different offer shows the replacement offer first", async () => {
    answer(view({ state: "not-installed" }));
    // The install the person confirmed fails with a network error — but the failure a
    // concurrent installer recorded is for a different lock.
    const replacementHash = "d".repeat(64);
    const replacement = view({ state: "failed", reason: "network", detail: "the download failed", at: "2026-11-20T00:00:00.000Z" }, { offer: { lockHash: replacementHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    vi.mocked(hub.installComponent).mockResolvedValue(replacement);
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("dialog", { name: "Download Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledTimes(1);
    // The follow step shows the failure — and its Retry must not submit the replacement
    // offer sight unseen: it goes back to the confirmation panel, and nothing more is sent.
    expect((await within(dialog).findByRole("alert")).textContent).toContain("network error");
    expect(within(dialog).getByText("the download failed")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(hub.installComponent).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByTestId("component-offer-size").textContent).toContain(formatMiB(LOCK_TOTAL));
  });
  it("a repair retry after a failure for a different offer shows the replacement offer first", async () => {
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
    await userEvent.click(await screen.findByRole("button", { name: "Reinstall" }));
    const dialog = await screen.findByRole("dialog", { name: "Reinstall Graphify?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", LOCK_HASH, true);
    // A concurrent installer recorded a failure for a different lock: the dialog's offer
    // is now the replacement, and the repair Retry must show it before downloading.
    const replacementHash = "d".repeat(64);
    const replacement = view({
      state: "installed",
      version: { graphifyy: "0.9.95", python: "3.11.18" },
      path: "/p",
      launcher: "/p/graphify",
      lastFailure: { reason: "self-check", detail: "injected", at: "2026-11-18T00:00:00.000Z" },
    }, { offer: { lockHash: replacementHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [replacement] });
    await refreshComponents();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(hub.installComponent).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByTestId("component-offer-size").textContent).toContain(formatMiB(LOCK_TOTAL));
  });

  it("a cancelled repair retry for a different offer confirms the replacement and still forces the repair", async () => {
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
    expect(await within(dialog).findByText("The reinstall was cancelled; the installed copy is unchanged.")).toBeTruthy();
    // A concurrent installer recorded a failure for a different lock: the dialog's offer
    // is now the replacement, and the cancelled Retry must show it before downloading.
    const replacementHash = "d".repeat(64);
    const replacement = view({ state: "installed", version: { graphifyy: "0.9.95", python: "3.11.18" }, path: "/p", launcher: "/p/graphify" }, { offer: { lockHash: replacementHash, totalBytes: LOCK_TOTAL, location: "/home/u/.nema/runtime/graphify", hosts: ["new.example"] } });
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [replacement] });
    await refreshComponents();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(hub.installComponent).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByTestId("component-offer-size").textContent).toContain(formatMiB(LOCK_TOTAL));
    // Confirming the replacement still forces the repair: an unforced install over an
    // installed copy would be a no-op.
    await userEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(hub.installComponent).toHaveBeenCalledWith("graphify", replacementHash, true);
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
