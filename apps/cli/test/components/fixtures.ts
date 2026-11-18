// Fake component archives, a fake lock and a local fake upstream for installer tests. Nothing here
// reaches the network beyond 127.0.0.1, and nothing touches the real ~/.nema.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type TarEntry = { name: string; body?: string | Buffer; mode?: number; type?: "file" | "dir" | "symlink"; link?: string };

function tarHeader(entry: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(entry.name, 0, 100, "utf8");
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  h.write(octal(entry.mode ?? (entry.type === "dir" ? 0o755 : 0o644), 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(entry.type === "dir" ? "5" : entry.type === "symlink" ? "2" : "0", 156, "ascii");
  if (entry.link) h.write(entry.link, 157, 100, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

export function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.type === "dir" || entry.type === "symlink" ? Buffer.alloc(0) : Buffer.from(entry.body ?? "");
    parts.push(tarHeader(entry, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A stored (uncompressed) ZIP; the extractor does not check CRCs. */
export function zip(entries: Array<{ name: string; body: string | Buffer; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = Buffer.from(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((entry.mode ?? 0o644) | 0o100000) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export const PYTHON_RELEASE = "https://github.com/astral-sh/python-build-standalone/releases/download/20261026";
export const PYPI_FILES = "https://files.pythonhosted.org/packages/aa/bb";

export type FakeTarget = {
  python: { file: string; url: string; sha256: string; size: number; format: "tar.gz" };
  wheels: Array<{ file: string; url: string; sha256: string; size: number }>;
};

export type FakeComponent = {
  /** Lock target key for this machine. */
  key: string;
  files: Map<string, Buffer>;
  target: FakeTarget;
};

/**
 * A component whose fake `python3.11` answers `-m graphify --version` and appends `$0` to `execLog`, so a
 * test can tell exactly which copy of it ever ran. `variant` changes the bytes, giving a different lock-hash.
 */
export function fakeComponent(execLog: string, variant = "a"): FakeComponent {
  const key = `${process.platform}-${process.arch}`;
  const python = tarGz([
    { name: "python/", type: "dir" },
    { name: "python/bin/", type: "dir" },
    {
      name: "python/bin/python3.11",
      mode: 0o755,
      body: `#!/bin/sh\necho "$0" >> ${JSON.stringify(execLog)}\nif [ "$1" = "-m" ] && [ "$2" = "graphify" ] && [ "$3" = "--version" ]; then echo "graphify 0.9.95-${variant}"; exit 0; fi\necho "graphify ran: $*"\n`,
    },
    { name: "python/bin/python3", type: "symlink", link: "python3.11" },
    { name: "python/lib/", type: "dir" },
    { name: "python/lib/python3.11/", type: "dir" },
    { name: "python/lib/python3.11/LICENSE.txt", body: "PSF license fixture\n" },
    { name: "python/lib/python3.11/os.py", body: `# stdlib fixture ${variant}\n` },
    { name: "python/lib/python3.11/tkinter/__init__.py", body: "# pruned\n" },
  ]);
  const graphifyy = zip([
    { name: "graphify/__init__.py", body: `__version__ = "0.9.95-${variant}"\n` },
    { name: "graphifyy-0.9.95.dist-info/METADATA", body: "Name: graphifyy\n" },
    { name: "graphifyy-0.9.95.dist-info/licenses/LICENSE", body: "graphify license fixture\n" },
  ]);
  const networkx = zip([{ name: "networkx/__init__.py", body: `# networkx ${variant}\n` }]);
  // File names carry the variant, so one fake source can serve several versions without mixing bytes.
  const pythonFile = `cpython-3.11.18+20261026-fixture-${variant}-install_only.tar.gz`;
  const graphifyyFile = `graphifyy-0.9.95-1${variant}-py3-none-any.whl`;
  const networkxFile = `networkx-3.6.1-1${variant}-py3-none-any.whl`;
  const files = new Map<string, Buffer>([
    [pythonFile, python],
    [graphifyyFile, graphifyy],
    [networkxFile, networkx],
  ]);
  const wheel = (file: string) => ({ file, url: `${PYPI_FILES}/${file}`, sha256: sha256(files.get(file)!), size: files.get(file)!.length });
  return {
    key,
    files,
    target: {
      python: { file: pythonFile, url: `${PYTHON_RELEASE}/${pythonFile.replace("+", "%2B")}`, sha256: sha256(python), size: python.length, format: "tar.gz" },
      wheels: [wheel(graphifyyFile), wheel(networkxFile)],
    },
  };
}

export function lockJson(targets: Record<string, unknown>): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    graphifyy: "0.9.95",
    python: "3.11.18",
    cpythonRelease: "20261026",
    extras: [],
    sourceCorrespondence: { status: "pending-task-7c" },
    targets,
  }, null, 2)}\n`;
}

export function writeLock(file: string, component: FakeComponent): string {
  writeFileSync(file, lockJson({ [component.key]: component.target }));
  return file;
}

/** A local stand-in for both upstreams, reached only through the two mirror variables. */
export type FakeSource = {
  url: string;
  /** Request paths, in order. */
  requests: string[];
  /** Serve these bytes for a file name instead of the component's. */
  override: Map<string, Buffer>;
  /** Return true after handling the response itself, to stall or break it. */
  intercept?: (file: string, req: IncomingMessage, res: ServerResponse) => boolean;
  /** The two mirror variables pointing here, plus `extra`. No proxy variables. */
  env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  close(): Promise<void>;
};

export async function fakeSource(...components: FakeComponent[]): Promise<FakeSource> {
  const requests: string[] = [];
  const override = new Map<string, Buffer>();
  const source = { requests, override } as FakeSource;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    const file = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (source.intercept?.(file, req, res)) return;
    const body = override.get(file) ?? components.map((component) => component.files.get(file)).find((bytes) => bytes !== undefined);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  source.url = base;
  source.env = (extra = {}) => ({ NEMA_GRAPHIFY_PYTHON_MIRROR: `${base}/python`, NEMA_GRAPHIFY_PYPI_BASE: `${base}/pypi`, ...extra });
  source.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return source;
}
