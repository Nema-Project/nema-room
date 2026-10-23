import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseOptions, setupSettings } from "./setup.mjs";

test("all three setup languages and read-only mode are available", () => {
  for (const lang of ["en", "zh", "ja"]) assert.deepEqual(parseOptions(["--lang", lang, "--check"]), { lang, check: true, help: false });
  assert.throws(() => parseOptions(["--lang", "unknown"]));
  assert.throws(() => parseOptions(["--unknown"]));
});

test("custom Compose host mount is also the daemon token location", () => {
  const data = path.join(os.tmpdir(), "Nema space", "日本語");
  const s = setupSettings({ NEMA_DATA_DIR: "~/ignored", NEMA_DATA_HOST_DIR: data, NEMA_HUB_PORT: "5500" }, {}, os.homedir());
  assert.equal(s.dataDir, data);
  assert.equal(s.tokenFile, path.join(data, "daemon-token"));
  assert.equal(s.hubUrl, "http://127.0.0.1:5500");
});

test("shell overrides .env and home expands without shell evaluation", () => {
  const home = path.join(os.tmpdir(), "test-home");
  const s = setupSettings({ NEMA_HUB_PORT: "5500", NEMA_DATA_DIR: "~/data" }, { NEMA_HUB_PORT: "6600" }, home);
  assert.equal(s.dataDir, path.join(home, "data"));
  assert.equal(s.port, "6600");
});

test("reject invalid directories, port conflicts and unresolved variable expressions before changes", () => {
  for (const value of ["relative/path", "${HOME}/data", "~/bad\npath"]) assert.throws(() => setupSettings({ NEMA_DATA_HOST_DIR: value }, {}));
  for (const value of ["0", "65536", "3000", "5433", "4400;echo bad"]) assert.throws(() => setupSettings({ NEMA_HUB_PORT: value }, {}));
  assert.throws(() => setupSettings({ NEMA_UID: "oops" }, {}));
});
