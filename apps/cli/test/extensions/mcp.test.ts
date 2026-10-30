import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMcpConfigs } from "../../src/extensions/mcp.js";
import { openExtensionStore } from "../../src/extensions/store.js";
import { openMcpSecretStore } from "../../src/secrets/mcp.js";

const MARK = "nema-test-secret-7f3a";

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nema-mcp-config-"));
  root = join(home, "extensions");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const stdio = (args: string[] = ["server.mjs"]) => ({
  transport: "stdio",
  command: "node",
  args,
  env: { API_TOKEN: { secret: "API_TOKEN" }, LOG_LEVEL: { value: "info" } },
});
const http = (url = "https://mcp.example.com/mcp") => ({ transport: "http", url, headers: { Authorization: { secret: "AUTH" } } });

function open() {
  return openMcpConfigs({ root, nemaHome: home });
}

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function record(id: string) {
  return openExtensionStore(root).list().find((row) => row.id === id);
}

const configFile = (id: string) => join(root, "extensions", id, "mcp.json");

/** Every byte Nema writes outside the secret files. */
function everythingButSecrets(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else parts.push(readFileSync(file, "utf8"));
    }
  };
  walk(root);
  return parts.join("\n");
}

test("save writes mcp.json first and a managed mcp record whose revision is its digest", () => {
  const configs = open();
  const saved = configs.save("search", "Search", stdio());
  expect(saved).toMatchObject({ id: "search", kind: "mcp", name: "Search", provision: "managed", source: "mcp:stdio", installState: "installed", availability: "ready" });
  expect(saved.revision).toMatch(/^[0-9a-f]{12}$/);
  expect(record("search")).toEqual(saved);
  // Same mode as index.json; the file holds references, not values.
  if (process.platform !== "win32") expect(statSync(configFile("search")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(configFile("search"), "utf8"))).toEqual(stdio());

  const again = configs.save("search", "Search", { ...stdio(), env: { ...stdio().env, LOG_LEVEL: { value: "debug" } } });
  expect(again.revision).not.toBe(saved.revision);
  expect(configs.save("web", "Web", http()).source).toBe("mcp:http");
});

test("get returns the config with references only and which secrets are set", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  expect(configs.get("search")).toEqual({ id: "search", name: "Search", config: stdio(), secrets: [{ name: "API_TOKEN", configured: false }] });
  configs.setSecret("search", "API_TOKEN", MARK);
  const got = configs.get("search");
  expect(got.secrets).toEqual([{ name: "API_TOKEN", configured: true }]);
  expect(JSON.stringify(got)).not.toContain(MARK);
  expect(everythingButSecrets()).not.toContain(MARK);
});

test("save keeps the use state of an existing record", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  openExtensionStore(root).setUseState("search", "disabled");
  expect(configs.save("search", "Search 2", stdio()).useState).toBe("disabled");
});

test("save refuses a bad config, a bad id or name, and writes nothing", () => {
  const configs = open();
  expect(message(() => configs.save("search", "Search", { ...stdio(), env: { API_TOKEN: { value: MARK } } }))).not.toContain(MARK);
  for (const id of ["Bad", "../x", "", "a/b"]) expect(message(() => configs.save(id, "X", stdio()))).toMatch(/invalid extension id/);
  for (const name of ["", "a\nb", "x".repeat(129)]) expect(message(() => configs.save("search", name, stdio()))).toMatch(/name/);
  expect(existsSync(join(root, "extensions", "search"))).toBe(false);
  expect(existsSync(join(root, "index.json"))).toBe(false);
});

test("save refuses an id held by a skill or a bundled plugin and leaves it alone", () => {
  const store = openExtensionStore(root);
  store.putManaged({
    id: "notes", kind: "skill", name: "notes", summary: "", source: "nema install", revision: "abc", provision: "managed",
    installState: "installed", useState: "enabled", availability: "ready", externalPath: null, error: null,
  });
  writeFileSync(join(root, "extensions", "notes", "SKILL.md"), "# notes");
  const configs = open();
  expect(message(() => configs.save("notes", "Notes", stdio()))).toMatch(/not an MCP server/);
  expect(readdirSync(join(root, "extensions", "notes"))).toEqual(["SKILL.md"]);
  expect(record("notes")?.kind).toBe("skill");
  expect(message(() => configs.save("github", "GitHub", stdio()))).toMatch(/not an MCP server/);
  expect(message(() => configs.get("notes"))).toMatch(/not an MCP server/);
  expect(message(() => configs.remove("notes"))).toMatch(/not an MCP server/);
});

test("changing the command, its arguments, the URL or the transport clears stored secrets", () => {
  const configs = open();
  const secrets = openMcpSecretStore(home);
  configs.save("search", "Search", stdio());
  configs.setSecret("search", "API_TOKEN", MARK);
  configs.save("search", "Search", { ...stdio(), env: { ...stdio().env, LOG_LEVEL: { value: "debug" } } });
  expect(secrets.names("search")).toEqual(["API_TOKEN"]);
  configs.save("search", "Search", stdio(["other.mjs"]));
  expect(secrets.names("search")).toEqual([]);

  configs.save("web", "Web", http());
  configs.setSecret("web", "AUTH", MARK);
  configs.save("web", "Web", http("https://elsewhere.example.com/mcp"));
  expect(secrets.names("web")).toEqual([]);
  configs.setSecret("web", "AUTH", MARK);
  configs.save("web", "Web", stdio());
  expect(secrets.names("web")).toEqual([]);
});

test("a save prunes secrets the new config no longer references", () => {
  const configs = open();
  const secrets = openMcpSecretStore(home);
  const two = { ...stdio(), env: { API_TOKEN: { secret: "API_TOKEN" }, OTHER_TOKEN: { secret: "OTHER" } } };
  configs.save("search", "Search", two);
  configs.setSecret("search", "API_TOKEN", MARK);
  configs.setSecret("search", "OTHER", MARK);
  configs.save("search", "Search", stdio());
  expect(secrets.names("search")).toEqual(["API_TOKEN"]);
  // Bringing the reference back does not bring the old value back.
  configs.save("search", "Search", two);
  expect(configs.get("search").secrets).toEqual([{ name: "API_TOKEN", configured: true }, { name: "OTHER", configured: false }]);
});

test("changing cwd clears stored secrets", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  configs.setSecret("search", "API_TOKEN", MARK);
  configs.save("search", "Search", { ...stdio(), cwd: join(home, "elsewhere") });
  expect(openMcpSecretStore(home).names("search")).toEqual([]);
});

test("a remove cut off after the secrets went can be run again", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  configs.setSecret("search", "API_TOKEN", MARK);
  // The first steps of a remove that stopped before the record went.
  openMcpSecretStore(home).removeAll("search");
  rmSync(join(root, "extensions", "search"), { recursive: true });
  expect(configs.reconcile().damaged).toEqual(["search"]);
  configs.remove("search");
  expect(record("search")).toBeUndefined();
});

test("a save with a damaged previous file also clears secrets", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  configs.setSecret("search", "API_TOKEN", MARK);
  writeFileSync(configFile("search"), "{not json");
  configs.save("search", "Search", stdio());
  expect(openMcpSecretStore(home).names("search")).toEqual([]);
});

test("setSecret accepts only names the config references; clearSecret removes one", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  expect(message(() => configs.setSecret("search", "OTHER", MARK))).toMatch(/OTHER.*not referenced/);
  expect(message(() => configs.setSecret("missing", "API_TOKEN", MARK))).toMatch(/not found/);
  const bad = message(() => configs.setSecret("search", "API_TOKEN", `${MARK}\n`));
  expect(bad).not.toBe("");
  expect(bad).not.toContain(MARK);
  configs.setSecret("search", "API_TOKEN", MARK);
  configs.clearSecret("search", "API_TOKEN");
  expect(configs.get("search").secrets).toEqual([{ name: "API_TOKEN", configured: false }]);
});

test("a hand-edited mcp.json marks the record damaged", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  writeFileSync(configFile("search"), JSON.stringify({ ...stdio(), env: { API_TOKEN: { value: MARK } } }));
  const text = message(() => configs.get("search"));
  expect(text).toMatch(/damaged/);
  expect(text).not.toContain(MARK);
  expect(record("search")).toMatchObject({ availability: "damaged" });
  expect(record("search")?.error ?? "").not.toContain(MARK);
});

test("remove deletes secrets, the managed directory and the record", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  configs.setSecret("search", "API_TOKEN", MARK);
  configs.remove("search");
  expect(existsSync(join(root, "extensions", "search"))).toBe(false);
  expect(existsSync(join(home, "secrets", "mcp", "search"))).toBe(false);
  expect(record("search")).toBeUndefined();
});

test("reconcile marks missing or mismatched mcp.json damaged, restores a matching one, and drops orphan secrets", () => {
  const configs = open();
  const secrets = openMcpSecretStore(home);
  configs.save("gone", "Gone", stdio());
  configs.save("edited", "Edited", stdio());
  configs.save("fine", "Fine", stdio());
  rmSync(configFile("gone"));
  writeFileSync(configFile("edited"), JSON.stringify(stdio(["changed.mjs"])));
  // mcp.json written, record not: the crash window between the two writes.
  mkdirSync(join(root, "extensions", "half"), { recursive: true });
  writeFileSync(join(root, "extensions", "half", "mcp.json"), JSON.stringify(stdio()));
  secrets.set("orphan", "API_TOKEN", MARK);
  secrets.set("fine", "API_TOKEN", MARK);

  expect(configs.reconcile()).toEqual({ damaged: ["edited", "gone"], removedSecrets: ["orphan"], clearedSlots: [] });
  expect(record("gone")?.availability).toBe("damaged");
  expect(record("edited")?.availability).toBe("damaged");
  expect(record("fine")?.availability).toBe("ready");
  expect(record("half")).toBeUndefined();
  expect(secrets.ids()).toEqual(["fine"]);

  // Saving again repairs a damaged record.
  expect(configs.save("gone", "Gone", stdio()).availability).toBe("ready");
  expect(configs.reconcile()).toEqual({ damaged: ["edited"], removedSecrets: [], clearedSlots: [] });
  expect(everythingButSecrets()).not.toContain(MARK);
});

test("reconcile clears a stored credential the saved config no longer names", () => {
  const configs = open();
  configs.save("search", "Search", stdio());
  configs.setSecret("search", "API_TOKEN", MARK);
  // A save cut off after writing the new config but before pruning leaves this behind.
  openMcpSecretStore(home).set("search", "OLD_TOKEN", MARK);
  const result = open().reconcile();
  expect(result.clearedSlots).toEqual(["search/OLD_TOKEN"]);
  expect(openMcpSecretStore(home).names("search")).toEqual(["API_TOKEN"]);
});
