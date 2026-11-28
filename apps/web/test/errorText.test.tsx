import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_ERROR, HUB_ERROR, PROGRESS, SKILL_WARNING } from "@nema/shared";
import { ERROR_KEY, hubErrorText, progressText, type ProgressLine } from "@/lib/errorText";
import { HubError, listRepos } from "@/lib/hub";
import { I18nProvider, useT } from "@/lib/i18n";

const LOCALES = ["en", "ja", "zh"] as const;
const catalog = (locale: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../messages/${locale}.json`), "utf8")) as Record<string, string>;

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

function Show({ error, line }: { error?: unknown; line?: ProgressLine }) {
  const t = useT();
  return <p data-testid="out">{error !== undefined ? hubErrorText(error, t) : progressText(line!, t)}</p>;
}

async function shown(locale: string, props: { error?: unknown; line?: ProgressLine }): Promise<string> {
  localStorage.setItem("nema.locale", locale);
  const { unmount } = render(<I18nProvider><Show {...props} /></I18nProvider>);
  // The provider settles the stored locale in an effect; wait for its rendered language.
  await vi.waitFor(() => expect(document.documentElement.lang).toBe(locale));
  const text = screen.getByTestId("out").textContent ?? "";
  unmount();
  return text;
}

describe("error and progress codes (#299 batch 1)", () => {
  it("every code the hub, daemon and progress lines send has a message in all three catalogs", () => {
    for (const locale of LOCALES) {
      const copy = catalog(locale);
      for (const code of [...Object.values(HUB_ERROR), ...Object.values(DAEMON_ERROR)]) {
        const key = ERROR_KEY[code] ?? `error.${code}`;
        expect(copy[key], `${locale} ${key}`).toBeTruthy();
      }
      for (const code of [...Object.values(PROGRESS), ...Object.values(SKILL_WARNING)]) expect(copy[`progress.${code}`], `${locale} progress.${code}`).toBeTruthy();
    }
  });

  it("a coded hub error is shown in the page's language, with its params", async () => {
    const error = new HubError(409, "本 workspace 已有用途为 web 的仓库", undefined, { code: "repo.label-taken", params: { label: "web" } });
    expect(await shown("en", { error })).toBe("This workspace already has a repository labelled web.");
    expect(await shown("ja", { error })).toBe(catalog("ja")["error.repo.label-taken"]!.replace("{label}", "web"));
  });

  it("an uncoded error, or a code the catalog does not know, keeps the hub's text", async () => {
    expect(await shown("en", { error: new HubError(400, "旧 hub 的原文") })).toBe("旧 hub 的原文");
    expect(await shown("en", { error: new HubError(400, "未知代码的原文", undefined, { code: "repo.not-yet-known" }) })).toBe("未知代码的原文");
    expect(await shown("en", { error: new Error("plain") })).toBe("plain");
  });

  it("a changed component offer reuses the component copy from #297", async () => {
    const error = new HubError(400, "the component offer changed; confirm again", undefined, { code: "components.offer-changed" });
    for (const locale of LOCALES) expect(await shown(locale, { error })).toBe(catalog(locale)["components.reason.offerChanged"]);
  });

  it("an error class of another client is read by shape, and a Node code is not a UI code", async () => {
    expect(await shown("en", { error: Object.assign(new Error("gone"), { code: "ENOENT" }) })).toBe("gone");
    expect(await shown("en", { error: Object.assign(new Error("x"), { code: "repo.label-invalid" }) })).toBe(catalog("en")["error.repo.label-invalid"]);
  });

  it("Graphify facts still win over the plain text", async () => {
    const error = new HubError(503, "graphify 未安装", { code: "graphify-interrupted" }, { code: "daemon.timed-out" });
    expect(await shown("en", { error })).toBe(catalog("en")["components.state.interrupted"]);
  });

  it("the hub client reads code and params from the error body and drops malformed ones", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "不是 git 仓库的根目录", code: "repo.not-git-root", params: { path: "/x", bad: { n: 1 } } }), { status: 400 })));
    const coded = await listRepos("ws").catch((e: unknown) => e);
    expect(coded).toBeInstanceOf(HubError);
    expect(coded).toMatchObject({ message: "不是 git 仓库的根目录", code: "repo.not-git-root", params: { path: "/x" } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x", code: "<b>", params: { a: "1" } }), { status: 400 })));
    const malformed = await listRepos("ws").catch((e: unknown) => e) as HubError;
    expect(malformed.code).toBeUndefined();
    expect(malformed.params).toBeUndefined();
  });

  it("an account switch reuses the route failure phrases", async () => {
    const line: ProgressLine = { text: "a 被限流，改用 b", code: "route.switch", params: { from: "a", to: "b", reason: "rate_limit" } };
    expect(await shown("en", { line })).toBe("a was rate limited; switching to b");
    const unknownReason: ProgressLine = { ...line, params: { from: "a", to: "b", reason: "weird" } };
    expect(await shown("en", { line: unknownReason })).toBe(`a ${catalog("en")["route.failure.unknown"]}; switching to b`);
  });

  it("a list line localises each item and keeps an uncoded item's text", async () => {
    const line: ProgressLine = {
      text: "部分 Skill 未载入：…",
      code: "skills.not-loaded",
      items: [{ text: "web：仓库位置已不是绑定时的那个仓库", code: "skill.repo-moved", params: { repo: "web" } }, { text: "x: EACCES" }],
    };
    expect(await shown("en", { line })).toBe("Some Skills were not loaded: web: the folder is no longer the repository that was bound; its Skills are skipped; x: EACCES");
  });

  it("an uncoded line, or one with an unknown code, is shown as the daemon wrote it", async () => {
    expect(await shown("en", { line: { text: "调用 foo" } })).toBe("调用 foo");
    expect(await shown("en", { line: { text: "未来的进度", code: "future.thing" } })).toBe("未来的进度");
  });
});
