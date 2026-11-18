// Offline component packs: `pack` stores the lock's archives unchanged plus an untrusted manifest; `import`
// trusts only the shipped lock and assembles through the online installer's own path. The fake python is a
// shell script, so the suite runs on POSIX.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installComponent, POSIX_LAUNCHER, sameTree, type InstallOptions } from "../../src/components/install.js";
import { lockHash } from "../../src/components/lock.js";
import { importComponent, packComponent, PACK_FORMAT, PackRejectedError } from "../../src/components/pack.js";
import { componentBin, componentStatus, readPointer, type ComponentEnv } from "../../src/components/store.js";
import { ComponentInstallError } from "../../src/components/types.js";
import { fakeComponent, fakeSource, sha256, tar, writeLock, type FakeComponent, type FakeSource } from "./fixtures.js";

let root: string;
let execLog: string;
let sources: FakeSource[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-component-pack-test-"));
  execLog = path.join(root, "exec.log");
  writeFileSync(execLog, "");
});

afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  rmSync(root, { recursive: true, force: true });
});

const quick: InstallOptions["hooks"] = { retryDelaysMs: [0, 0, 0], timeoutMs: 2_000, freeBytes: async () => Number.MAX_SAFE_INTEGER };
const ran = () => readFileSync(execLog, "utf8").split("\n").filter(Boolean);

async function serve(...components: FakeComponent[]): Promise<FakeSource> {
  const source = await fakeSource(...components);
  sources.push(source);
  return source;
}

function envFor(component: FakeComponent, runtime: string, vars: NodeJS.ProcessEnv = {}, extra: Partial<ComponentEnv> = {}): ComponentEnv {
  const lockPath = writeLock(path.join(root, `lock-${lockHash(component.target).slice(0, 8)}.json`), component);
  return { env: vars, runtimeRoot: path.join(root, runtime), lockPath, platform: { platform: process.platform, arch: process.arch, musl: false }, ...extra };
}

type Entry = { name: string; type: string; body: Buffer };

/** A test-side tar reader, independent of the one under test. */
function untar(buf: Buffer): Entry[] {
  const out: Entry[] = [];
  let pos = 0;
  let paxPath: string | undefined;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(h.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = Buffer.from(buf.subarray(pos + 512, pos + 512 + size));
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = / path=(.*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    out.push({ name: paxPath ?? name, type, body });
    paxPath = undefined;
  }
  return out;
}

function manifestFor(component: FakeComponent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const entries = [component.target.python, ...component.target.wheels];
  return {
    format: PACK_FORMAT,
    component: "graphify",
    target: component.key,
    lockHash: lockHash(component.target),
    tool: { name: "nema", version: "test" },
    archives: entries.map(({ file, size }) => ({ file, size })),
    ...overrides,
  };
}

type PackEntry = Parameters<typeof tar>[0][number];

/** A hand-built pack: by default exactly what `pack` would write for `component`. */
function writePackFile(
  component: FakeComponent,
  o: { manifest?: Record<string, unknown>; archives?: Map<string, Buffer>; extra?: PackEntry[]; file?: string } = {},
): string {
  const archives = o.archives ?? component.files;
  const entries: PackEntry[] = [
    { name: "manifest.json", body: `${JSON.stringify(o.manifest ?? manifestFor(component))}\n` },
    ...[...archives].map(([file, body]) => ({ name: `archives/${file}`, body })),
    ...(o.extra ?? []),
  ];
  const file = o.file ?? path.join(root, `hand-${Math.random().toString(16).slice(2)}.nema-component`);
  writeFileSync(file, tar(entries));
  return file;
}

const storeDir = (env: ComponentEnv) => path.join(env.runtimeRoot!, "graphify");
const versions = (env: ComponentEnv) => (existsSync(storeDir(env)) ? readdirSync(storeDir(env)).filter((name) => /^[a-f0-9]{64}$/.test(name)) : []);

describe.skipIf(process.platform === "win32")("nema components pack", () => {
  test("stores the lock's archives byte for byte plus an index-only manifest, and assembles nothing", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, "maker", source.env());
    const result = await packComponent("graphify", { dir: root, env, hooks: quick, toolVersion: "9.9.9" });
    const hash = lockHash(component.target);
    expect(path.basename(result.file)).toBe(`graphify-${component.key}-${hash.slice(0, 12)}.nema-component`);
    const entries = untar(readFileSync(result.file));
    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json", ...[component.target.python, ...component.target.wheels].map((entry) => `archives/${entry.file}`)]);
    for (const entry of entries.slice(1)) {
      expect(entry.type).toBe("0");
      expect(entry.body.equals(component.files.get(path.posix.basename(entry.name))!)).toBe(true);
    }
    const manifest = JSON.parse(entries[0]!.body.toString("utf8"));
    // Only the allowed index fields: no hashes, no assembled-file table.
    expect(Object.keys(manifest).sort()).toEqual(["archives", "component", "format", "lockHash", "target", "tool"]);
    expect(manifest).toEqual(manifestFor(component, { tool: { name: "nema", version: "9.9.9" } }));
    expect(result.manifest).toEqual(manifest);
    // Packing downloads and verifies; it neither installs nor runs anything.
    expect(existsSync(storeDir(env))).toBe(false);
    expect(ran()).toEqual([]);
  });

  test("refuses to pack when downloads are off, without a single request", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, "maker", source.env({ NEMA_GRAPHIFY_OFFLINE: "1" }));
    await expect(packComponent("graphify", { dir: root, env, hooks: quick, toolVersion: "t" })).rejects.toMatchObject({ reason: "offline" });
    expect(source.requests).toEqual([]);
    expect(readdirSync(root).some((name) => name.endsWith(".nema-component"))).toBe(false);
  });

  test("a download that does not match the lock leaves no pack", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const bad = Buffer.from(component.files.get(component.target.wheels[0]!.file)!);
    bad[bad.length - 1] ^= 0xff;
    source.override.set(component.target.wheels[0]!.file, bad);
    const env = envFor(component, "maker", source.env());
    const error = await packComponent("graphify", { dir: root, env, hooks: quick, toolVersion: "t" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComponentInstallError);
    expect((error as ComponentInstallError).reason).toBe("hash-mismatch");
    expect(readdirSync(root).filter((name) => name.includes(".nema-component"))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("nema components import", () => {
  test("imports offline into the same tree an online install builds, and self-checks it", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const maker = envFor(component, "maker", source.env());
    const { file } = await packComponent("graphify", { dir: root, env: maker, hooks: quick, toolVersion: "t" });
    const online = envFor(component, "online", source.env());
    expect(await installComponent("graphify", { env: online, hooks: quick })).toMatchObject({ state: "installed" });
    const requests = source.requests.length;

    // The importing machine is offline: the switch is on and the mirrors point at a closed port.
    await source.close();
    sources = sources.filter((s) => s !== source);
    const target = envFor(component, "importer", { NEMA_GRAPHIFY_PYTHON_MIRROR: `${source.url}/python`, NEMA_GRAPHIFY_PYPI_BASE: `${source.url}/pypi` }, { offline: true });
    const hash = lockHash(component.target);
    const before = ran().length;
    const result = await importComponent("graphify", file, { env: target, hooks: quick });
    expect(result.status).toMatchObject({ state: "installed", lockHash: hash, path: path.join(storeDir(target), hash) });
    expect(result.ignored).toEqual([]);
    expect(source.requests.length).toBe(requests);
    expect(readPointer(storeDir(target))).toEqual(readPointer(storeDir(online)));
    expect(readPointer(storeDir(target))).toEqual({ active: hash, previous: null });
    expect(await sameTree(path.join(storeDir(target), hash), path.join(storeDir(online), hash))).toBe(true);
    expect(componentBin("graphify", target)).toBe(path.join(storeDir(target), hash, "graphify"));
    // The self-check ran the staged copy of the importer's own assembly.
    expect(ran().slice(before)).toEqual([path.join(storeDir(target), `${hash}.staging`, "python", "bin", "python3.11")]);
    expect(await componentStatus(target)).toMatchObject({ state: "installed" });
  });

  test("importing again repairs a damaged installed copy, offline", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const maker = envFor(component, "maker", source.env());
    const { file } = await packComponent("graphify", { dir: root, env: maker, hooks: quick, toolVersion: "t" });
    await source.close();
    sources = sources.filter((s) => s !== source);
    const target = envFor(component, "importer", {}, { offline: true });
    const hash = lockHash(component.target);
    expect((await importComponent("graphify", file, { env: target, hooks: quick })).status).toMatchObject({ state: "installed" });
    // Damage the installed tree; a second import of the same pack is the offline repair path.
    const damaged = path.join(storeDir(target), hash, "python", "lib", "python3.11", "os.py");
    writeFileSync(damaged, "# damaged\n");
    const repaired = await importComponent("graphify", file, { env: target, hooks: quick });
    expect(repaired.status).toMatchObject({ state: "installed", lockHash: hash });
    expect(readFileSync(damaged, "utf8")).not.toContain("damaged");
    expect(readPointer(storeDir(target)).active).toBe(hash);
  });

  test("rejects a pack for another lock-hash or target, naming why, and changes nothing", async () => {
    const component = fakeComponent(execLog);
    const env = envFor(component, "importer", {}, { offline: true });
    const otherHash = lockHash(fakeComponent(execLog, "other").target);
    const wrongHash = writePackFile(component, { manifest: manifestFor(component, { lockHash: otherHash }) });
    await expect(importComponent("graphify", wrongHash, { env, hooks: quick })).rejects.toThrow(new RegExp(`lock-hash "${otherHash}" is not this Nema build's ${lockHash(component.target)}`));
    const wrongTarget = writePackFile(component, { manifest: manifestFor(component, { target: "plan9-mips" }) });
    await expect(importComponent("graphify", wrongTarget, { env, hooks: quick })).rejects.toThrow(/for target "plan9-mips"; this machine needs/);
    const noManifest = path.join(root, "no-manifest.nema-component");
    writeFileSync(noManifest, tar([...component.files].map(([name, body]) => ({ name: `archives/${name}`, body }))));
    await expect(importComponent("graphify", noManifest, { env, hooks: quick })).rejects.toBeInstanceOf(PackRejectedError);
    expect(existsSync(storeDir(env))).toBe(false);
    expect(ran()).toEqual([]);
  });

  test("rejects a pack with one archive too many or one too few", async () => {
    const component = fakeComponent(execLog);
    const env = envFor(component, "importer", {}, { offline: true });
    const extra = new Map(component.files);
    extra.set("evil-1.0-py3-none-any.whl", Buffer.from("not in the lock"));
    await expect(importComponent("graphify", writePackFile(component, { archives: extra }), { env, hooks: quick })).rejects.toThrow(/unexpected: evil-1\.0-py3-none-any\.whl/);
    const fewer = new Map(component.files);
    fewer.delete(component.target.wheels[1]!.file);
    await expect(importComponent("graphify", writePackFile(component, { archives: fewer }), { env, hooks: quick })).rejects.toThrow(new RegExp(`missing: ${component.target.wheels[1]!.file.replace(/[.+]/g, "\\$&")}`));
    expect(existsSync(storeDir(env))).toBe(false);
  });

  test("tamper form 1: a replaced archive with a self-consistent manifest never becomes active", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const env = envFor(component, "importer", {}, { offline: true });
    // A replacement python archive of the same size under the locked name, with a manifest whose claimed
    // hashes and sizes agree with the replacement (and a claimed launcher hash of its own).
    const original = component.files.get(component.target.python.file)!;
    const swapped = Buffer.from(original);
    swapped[swapped.length - 32] ^= 0x01;
    const archives = new Map(component.files);
    archives.set(component.target.python.file, swapped);
    const manifest = manifestFor(component, {
      archives: [...archives].map(([file, body]) => ({ file, size: body.length, sha256: sha256(body) })),
      files: { graphify: sha256("#!/bin/sh\nexec evil\n") },
    });
    const status = (await importComponent("graphify", writePackFile(component, { archives, manifest }), { env, hooks: quick })).status;
    expect(status).toMatchObject({ state: "failed", reason: "hash-mismatch", lockHash: hash });
    expect(versions(env)).toEqual([]);
    expect(readPointer(storeDir(env))).toEqual({ active: null, previous: null });
    expect(componentBin("graphify", env)).toBeNull();
    expect(ran()).toEqual([]);

    // A replacement of another size is turned away before anything is written.
    const bigger = new Map(component.files);
    bigger.set(component.target.python.file, Buffer.concat([original, Buffer.from("tail")]));
    const sized = writePackFile(component, { archives: bigger, manifest: manifestFor(component, { archives: [...bigger].map(([file, body]) => ({ file, size: body.length })) }) });
    await expect(importComponent("graphify", sized, { env, hooks: quick })).rejects.toThrow(/bytes in the pack; the lock says/);
    expect(versions(env)).toEqual([]);
  });

  test("tamper form 2: a prebuilt directory and scripts beside genuine archives are ignored and never run", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const env = envFor(component, "importer", {}, { offline: true });
    const marker = path.join(root, "evil-ran");
    const evil = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`;
    const extra: PackEntry[] = [
      { name: "prebuilt/", type: "dir" },
      { name: `prebuilt/${hash.slice(0, 16)}/`, type: "dir" },
      { name: `prebuilt/${hash.slice(0, 16)}/graphify`, body: evil, mode: 0o755 },
      { name: `prebuilt/${hash.slice(0, 16)}/python/bin/python3.11`, body: evil, mode: 0o755 },
      { name: "graphify", body: evil, mode: 0o755 },
      { name: "install.sh", body: evil, mode: 0o755 },
      { name: "archives/nested/graphify", body: evil, mode: 0o755 },
      { name: "archives/link.whl", type: "symlink", link: "../install.sh" },
    ];
    // The manifest's hashes are garbage; they are never read, so they cannot block or allow anything.
    const manifest = manifestFor(component, { sha256: "0".repeat(64), launcher: sha256(evil) });
    const result = await importComponent("graphify", writePackFile(component, { extra, manifest }), { env, hooks: quick });
    expect(result.status).toMatchObject({ state: "installed", lockHash: hash });
    expect([...result.ignored].sort()).toEqual(extra.map((entry) => entry.name).sort());
    const active = path.join(storeDir(env), hash);
    // The launcher is the installer's own text, not the pack's.
    expect(readFileSync(path.join(active, "graphify"), "utf8")).toBe(POSIX_LAUNCHER);
    expect(existsSync(path.join(active, "prebuilt"))).toBe(false);
    expect(existsSync(path.join(active, "install.sh"))).toBe(false);
    expect(readFileSync(path.join(active, "python", "bin", "python3.11"), "utf8")).not.toContain("evil-ran");
    expect(existsSync(marker)).toBe(false);
    expect(ran()).toEqual([path.join(storeDir(env), `${hash}.staging`, "python", "bin", "python3.11")]);
  });

  test("a truncated or non-tar file is rejected", async () => {
    const component = fakeComponent(execLog);
    const env = envFor(component, "importer", {}, { offline: true });
    const full = readFileSync(writePackFile(component));
    const truncated = path.join(root, "truncated.nema-component");
    writeFileSync(truncated, full.subarray(0, 700));
    await expect(importComponent("graphify", truncated, { env, hooks: quick })).rejects.toBeInstanceOf(PackRejectedError);
    const garbage = path.join(root, "garbage.nema-component");
    writeFileSync(garbage, Buffer.alloc(2048, 0x41));
    await expect(importComponent("graphify", garbage, { env, hooks: quick })).rejects.toBeInstanceOf(PackRejectedError);
    expect(existsSync(storeDir(env))).toBe(false);
  });
});
