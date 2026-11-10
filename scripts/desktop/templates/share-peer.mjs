// Plain-Node copy of apps/local/src/sharePeer.ts for the desktop parent and the web image.
// scripts/desktop/templates/share-peer-guard.test.mjs fails if the two decisions diverge.
const FORWARDING_HEADERS = new Set([
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-host",
]);

export const SHARE_PEER_HEADER = "x-nema-share-peer";

function parseIpv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4Allowed(value) {
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function ipv6Hextets(address) {
  const bare = address.split("%")[0] ?? "";
  const input = bare.startsWith("[") && bare.endsWith("]") ? bare.slice(1, -1) : bare;
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side) => {
    if (side === "") return [];
    const parts = side.split(":");
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        const v4 = parseIpv4(part);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };
  const left = parseSide(halves[0] ?? "");
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseSide(halves[1] ?? "");
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

export function isPrivateSharePeer(address) {
  if (address.includes(".") && !address.includes(":")) {
    const v4 = parseIpv4(address);
    return v4 !== null && ipv4Allowed(v4);
  }
  const hextets = ipv6Hextets(address);
  if (!hextets || hextets.length !== 8) return false;
  const mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  if (mapped) return ipv4Allowed(((hextets[6] ?? 0) << 16) | (hextets[7] ?? 0));
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) return true;
  const first = hextets[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

function hasForwardingHeader(headers) {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    for (const name of FORWARDING_HEADERS) if (headers.has(name)) return true;
    return false;
  }
  return Object.entries(headers).some(([key, value]) => value !== undefined && FORWARDING_HEADERS.has(key.toLowerCase()));
}

export function sharePeerDecision(peer, headers) {
  if (hasForwardingHeader(headers) || !peer || !isPrivateSharePeer(peer)) return "reject";
  return "allow";
}

