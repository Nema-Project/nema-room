/** Stable GitHub release check. No telemetry, no download. */

export const LATEST_RELEASE_URL = "https://api.github.com/repos/Nema-Project/nema-room/releases/latest";
export const RELEASE_CHECK_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1_000_000;
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export type Semver = { major: number; minor: number; patch: number; prerelease: string[] };
export type ReleaseOffer = { version: string; url: string; tag: string };
export type ReleaseCheckState = "disabled" | "current" | "newer" | "error";
export type ReleaseCheckResult = { state: ReleaseCheckState; offer?: ReleaseOffer };

export function parseSemver(input: string): Semver | null {
  if (typeof input !== "string") return null;
  const match = SEMVER.exec(input.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const id of prerelease) {
    if (!/^(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)$/.test(id)) return null;
    if (/^\d+$/.test(id) && !Number.isSafeInteger(Number(id))) return null;
  }
  return { major, minor, patch, prerelease };
}

/** -1 when left is older, 1 when left is newer, 0 when equal, null when either side is malformed. */
export function compareSemver(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xNum !== yNum) return xNum ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function releasePageUrl(tag: string): string | null {
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) return null;
  return `https://github.com/Nema-Project/nema-room/releases/tag/${tag}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A stable release strictly newer than current. Drafts, prereleases, and malformed tags produce no offer. */
export function releaseOffer(current: string, body: unknown): ReleaseOffer | null {
  const release = record(body);
  if (!release || release.draft === true || release.prerelease === true || typeof release.tag_name !== "string") return null;
  const tag = release.tag_name.trim();
  const parsed = parseSemver(tag);
  if (!parsed || parsed.prerelease.length > 0) return null;
  if (compareSemver(current, tag) !== -1) return null;
  const url = releasePageUrl(tag);
  if (!url) return null;
  return { version: `${parsed.major}.${parsed.minor}.${parsed.patch}`, url, tag };
}

/** Reads until `max` bytes. A larger body is cancelled and rejected instead of buffered. */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  const body = response.body;
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > max ? null : bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchLatestRelease(current: string, options: {
  enabled: boolean;
  manual?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ReleaseCheckResult> {
  if (!options.enabled && !options.manual) return { state: "disabled" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? RELEASE_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Nema-Room",
      },
    });
    if (!response.ok) return { state: "error" };
    const bytes = await readCapped(response, MAX_BODY_BYTES);
    if (!bytes) return { state: "error" };
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { return { state: "error" }; }
    const offer = releaseOffer(current, payload);
    return offer ? { state: "newer", offer } : { state: "current" };
  } catch {
    return { state: "error" };
  } finally {
    clearTimeout(timer);
  }
}
