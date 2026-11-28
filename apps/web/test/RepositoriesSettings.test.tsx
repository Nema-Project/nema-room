import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoriesSettings } from "@/components/RepositoriesSettings";
import { formatDay, formatTime } from "@/lib/format";
import { I18nProvider, useLocale } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { Repo } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  listRepos: vi.fn(),
  pickDirectory: vi.fn(),
  previewRepo: vi.fn(),
  bindRepo: vi.fn(),
  updateRepo: vi.fn(),
  unbindRepo: vi.fn(),
}));

const repo = (extra: Partial<Repo> & Pick<Repo, "id" | "path" | "label">): Repo => ({
  workspaceId: "w1",
  gitCommonDir: extra.path,
  mainBranch: "main",
  hasOrigin: true,
  remoteUrl: null,
  githubTarget: null,
  lastMainSha: null,
  lastFetchAt: null,
  lastFetchError: null,
  trustSkills: false,
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(hub.listRepos).mockReset();
  vi.mocked(hub.pickDirectory).mockReset();
  vi.mocked(hub.previewRepo).mockReset();
  vi.mocked(hub.bindRepo).mockReset();
  vi.mocked(hub.updateRepo).mockReset();
  vi.mocked(hub.unbindRepo).mockReset();
  vi.mocked(hub.listRepos).mockResolvedValue([]);
  vi.mocked(hub.updateRepo).mockImplementation(async (id, repoId, patch) => repo({ id: repoId, workspaceId: id, path: `/tmp/${repoId}`, label: "app", ...patch }));
  vi.mocked(hub.unbindRepo).mockResolvedValue(undefined);
});

function mount() {
  render(
    <I18nProvider>
      <RepositoriesSettings workspaceId="w1" onRepoBound={vi.fn()} />
    </I18nProvider>,
  );
}

/** Switches the UI language mid-test, so locale-triggered refetches can be observed. */
function LocaleSwitcher() {
  const [, setLocale] = useLocale();
  return <button onClick={() => setLocale("ja")}>switch locale</button>;
}

const preview = {
  root: "/real/app",
  defaultBranch: "develop",
  hasOrigin: true,
  remoteUrl: "https://example.com/app.git",
  label: "app",
  labelTaken: false,
};

async function choose(path = "/tmp/app", next = preview) {
  vi.mocked(hub.pickDirectory).mockResolvedValueOnce({ path });
  vi.mocked(hub.previewRepo).mockResolvedValueOnce(next);
  await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
}

describe("RepositoriesSettings", () => {
  it("adds a repo from the preview and shows the hub's 409 message inline", async () => {
    const created = repo({ id: "r1", path: "/real/app", label: "app", mainBranch: "develop", remoteUrl: preview.remoteUrl });
    vi.mocked(hub.bindRepo).mockResolvedValueOnce(created).mockRejectedValueOnce(new Error("该仓库已绑定到 workspace Alpha"));
    mount();
    await screen.findByRole("button", { name: "Add repository" });
    expect((screen.getByRole("button", { name: "Add repository" }) as HTMLButtonElement).disabled).toBe(true);

    await choose();
    expect(screen.getByText("https://example.com/app.git")).toBeTruthy();
    expect(screen.getByText("develop")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Label" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(hub.bindRepo).toHaveBeenCalledWith("w1", { path: "/real/app", label: "app", mainBranch: "develop" });
    const path = await screen.findByText("/real/app");
    expect(path.classList.contains("repo-path")).toBe(true);
    expect(screen.getByText("None selected")).toBeTruthy();

    await choose("/tmp/dup", { ...preview, root: "/real/dup", label: "dup" });
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect((await screen.findByRole("alert")).textContent).toBe("该仓库已绑定到 workspace Alpha");
    expect(screen.getByText("/real/dup")).toBeTruthy();
    expect(hub.previewRepo).toHaveBeenLastCalledWith("w1", "/tmp/dup");
  });

  it("ignores a stale list response that resolves after a bind", async () => {
    const created = repo({ id: "r1", path: "/real/app", label: "app", mainBranch: "develop", remoteUrl: preview.remoteUrl });
    let resolveList!: (rows: Repo[]) => void;
    vi.mocked(hub.listRepos).mockImplementationOnce(() => new Promise<Repo[]>((resolve) => { resolveList = resolve; }));
    vi.mocked(hub.bindRepo).mockResolvedValueOnce(created);
    mount();
    await screen.findByRole("button", { name: "Add repository" });
    await choose();
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(hub.bindRepo).toHaveBeenCalledWith("w1", { path: "/real/app", label: "app", mainBranch: "develop" });
    // The add finished and the preview cleared, so the path below is the bound row, not the preview.
    expect(await screen.findByText("None selected")).toBeTruthy();
    await act(async () => { resolveList([]); });
    expect(screen.getByText("/real/app")).toBeTruthy();
  });

  it("keeps the loaded list when a locale reread fails", async () => {
    vi.mocked(hub.listRepos).mockResolvedValue([repo({ id: "r1", path: "/tmp/app", label: "app" })]);
    render(
      <I18nProvider>
        <LocaleSwitcher />
        <RepositoriesSettings workspaceId="w1" onRepoBound={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByText("/tmp/app")).toBeTruthy();
    vi.mocked(hub.listRepos).mockRejectedValue(new Error("list boom"));
    await userEvent.click(screen.getByRole("button", { name: "switch locale" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("list boom");
    expect(screen.getByText("/tmp/app")).toBeTruthy();
  });

  it("asks for another name when the suggested label is taken and ignores a cancelled pick", async () => {
    mount();
    await screen.findByRole("button", { name: "Add repository" });
    await choose("/tmp/app", { ...preview, labelTaken: true });
    expect(await screen.findByText("https://example.com/app.git")).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add repository" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText("This name is already used here. Choose another.")).toBeTruthy();
    vi.mocked(hub.pickDirectory).mockResolvedValueOnce({ path: null });
    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(hub.previewRepo).toHaveBeenCalledTimes(1);
    expect(screen.getByText("https://example.com/app.git")).toBeTruthy();

    const name = screen.getByRole("textbox", { name: "Label" });
    await userEvent.clear(name);
    await userEvent.type(name, "other");
    expect(add.disabled).toBe(false);
    vi.mocked(hub.bindRepo).mockResolvedValueOnce(repo({ id: "r2", path: "/real/app", label: "other", mainBranch: "develop" }));
    await userEvent.click(add);
    expect(hub.bindRepo).toHaveBeenCalledWith("w1", { path: "/real/app", label: "other", mainBranch: "develop" });
  });

  it("shows an inspect failure and does not bind", async () => {
    vi.mocked(hub.pickDirectory).mockResolvedValueOnce({ path: "/tmp/notes" });
    vi.mocked(hub.previewRepo).mockRejectedValueOnce(new Error("不是 git 仓库的根目录"));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Choose folder" }));
    expect((await screen.findByRole("alert")).textContent).toBe("不是 git 仓库的根目录");
    expect((screen.getByRole("button", { name: "Add repository" }) as HTMLButtonElement).disabled).toBe(true);
    expect(hub.bindRepo).not.toHaveBeenCalled();
  });

  it("shows no origin and fetch failure states", async () => {
    const fetchedAt = "2026-10-23T01:00:00.000Z";
    vi.mocked(hub.listRepos).mockResolvedValue([
      repo({ id: "r-local", path: "/tmp/local", label: "local", hasOrigin: false, lastFetchAt: fetchedAt, lastFetchError: "没有 origin" }),
      repo({ id: "r-fail", path: "/tmp/remote", label: "remote", mainBranch: "trunk", lastFetchAt: fetchedAt, lastFetchError: "origin unreachable" }),
      repo({ id: "r-ok", path: "/tmp/ok", label: "ok", lastFetchAt: fetchedAt }),
    ]);
    mount();

    expect(await screen.findByText("No origin; using the local branch")).toBeTruthy();
    expect(screen.queryByText(/没有 origin/)).toBeNull();
    const at = new Date(fetchedAt);
    const lastFetched = `Last fetched ${formatDay(at, "en")} ${formatTime(at, "en")}`;
    expect(screen.getByText(`Fetch failed origin unreachable · ${lastFetched}`)).toBeTruthy();
    expect(screen.getByText(lastFetched)).toBeTruthy();

    const label = screen.getByRole("textbox", { name: "Label /tmp/local" });
    await userEvent.clear(label);
    await userEvent.type(label, "renamed");
    await userEvent.tab();
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r-local", { label: "renamed" });

    const branch = screen.getByRole("textbox", { name: "Main branch /tmp/ok" });
    await userEvent.clear(branch);
    await userEvent.type(branch, "release");
    await userEvent.tab();
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r-ok", { mainBranch: "release" });

    const remove = screen.getByRole("button", { name: "Delete /tmp/remote" });
    expect(remove.classList.contains("settings-action")).toBe(true);
    expect(remove.className.includes("danger") || remove.className.includes("red")).toBe(false);
    await userEvent.click(remove);
    expect(hub.unbindRepo).toHaveBeenCalledWith("w1", "r-fail");
    expect(screen.queryByText("/tmp/remote")).toBeNull();
  });

  it("shows the GitHub target per repository", async () => {
    vi.mocked(hub.listRepos).mockResolvedValue([
      repo({ id: "r-gh", path: "/tmp/gh", label: "gh", remoteUrl: "git@github.com:Acme/App.git", githubTarget: "acme/app" }),
      repo({ id: "r-gl", path: "/tmp/gl", label: "gl", remoteUrl: "https://gitlab.com/acme/app.git", githubTarget: null }),
    ]);
    mount();

    const gh = (await screen.findByText("/tmp/gh")).closest(".repo-row")!;
    expect(within(gh as HTMLElement).getByText("acme/app")).toBeTruthy();
    expect(within(gh as HTMLElement).queryByText("No GitHub remote")).toBeNull();
    const gl = screen.getByText("/tmp/gl").closest(".repo-row")!;
    expect(within(gl as HTMLElement).getByText("No GitHub remote")).toBeTruthy();

  });
});

describe("trusting a repository's Skills", () => {
  it("is off by default, asks before turning on, and turns off without asking", async () => {
    vi.mocked(hub.listRepos).mockResolvedValue([repo({ id: "r1", path: "/tmp/app", label: "app" })]);
    vi.mocked(hub.updateRepo).mockImplementation(async (_id, repoId, patch) => repo({ id: repoId, path: "/tmp/app", label: "app", ...patch }));
    mount();
    const toggle = await screen.findByRole("checkbox", { name: "Trust this repository's Skills /tmp/app" });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    await userEvent.click(toggle);
    const dialog = screen.getByRole("group", { name: "Trust this repository's Skills /tmp/app" });
    expect(within(dialog).getByText(/\.agents\/skills/)).toBeTruthy();
    expect(hub.updateRepo).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Trust this repository's Skills /tmp/app" })).toBeNull();
    expect(hub.updateRepo).not.toHaveBeenCalled();
    expect((toggle as HTMLInputElement).checked).toBe(false);

    await userEvent.click(toggle);
    await userEvent.click(within(screen.getByRole("group", { name: "Trust this repository's Skills /tmp/app" })).getByRole("button", { name: "Trust" }));
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r1", { trustSkills: true });
    const on = await screen.findByRole("checkbox", { name: "Trust this repository's Skills /tmp/app" });
    expect((on as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Takes effect from the next task.")).toBeTruthy();

    vi.mocked(hub.updateRepo).mockClear();
    await userEvent.click(on);
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r1", { trustSkills: false });
    expect(screen.queryByRole("group", { name: "Trust this repository's Skills /tmp/app" })).toBeNull();
  });
});
