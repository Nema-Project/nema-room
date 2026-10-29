import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { npmCliBeside, npmEntryFromShim, parseOptions, setupSettings, TEXT } from "./setup.mjs";

test("windows npm launch finds the cli beside node and in current shims", async () => {
  const quoted = '"%dp0%\\node_modules\\npm\\bin\\npm-cli.js"';
  const assigned = 'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"';
  assert.equal(npmEntryFromShim(quoted), "node_modules\\npm\\bin\\npm-cli.js");
  assert.equal(npmEntryFromShim(assigned), "node_modules\\npm\\bin\\npm-cli.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "nema-npm-"));
  try {
    const entry = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "");
    assert.equal(npmCliBeside(dir), entry);
    assert.equal(npmCliBeside(path.join(dir, "missing")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("every setup language reports the version this checkout builds", () => {
  // The key names the trio the source tree would build; it is not a version selector, so all three
  // languages must present it as a fact about the checkout rather than a choice.
  for (const lang of ["en", "zh", "ja"]) {
    assert.ok(TEXT[lang].checkout, `${lang} is missing the checkout version label`);
    assert.ok(!/NEMA_IMAGE_TAG/.test(TEXT[lang].checkout), `${lang} must not mention NEMA_IMAGE_TAG as a selector`);
  }
  assert.match(TEXT.en.checkout, /checkout/i);
  assert.match(TEXT.zh.checkout, /检出/);
  assert.match(TEXT.ja.checkout, /チェックアウト/);
});
