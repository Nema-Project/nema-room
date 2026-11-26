/**
 * The hub's Host allowlist predicate, shared by the HTTP guard (app.ts `hostGuard`) and the
 * `/daemon` WebSocket upgrade (daemonSocket.ts) so both entry points apply one rule.
 *
 * Loopback (`127.0.0.1:<port>` / `localhost:<port>`) is always allowed. While `remoteAuth` is on,
 * the allowlist adds hosts the deployer explicitly named (NEMA_HUB_ALLOWED_HOSTS). An entry is a
 * hostname or a host:port; without a port it matches the Host's hostname part whatever port the
 * request carries. Without `remoteAuth` the list is ignored, so a mis-filled list can never widen
 * the local form. Matching is case-insensitive.
 */
export function createHostAllowed(
  port: number,
  opts: { allowedHosts?: string[]; remoteAuth?: boolean } = {},
): (host: string) => boolean {
  const loopback = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowed = (opts.allowedHosts ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  /** The hostname part of a Host value: the whole value, minus a trailing numeric :port. */
  const hostnameOf = (host: string): string => {
    const idx = host.lastIndexOf(":");
    return idx > 0 && /^\d+$/.test(host.slice(idx + 1)) ? host.slice(0, idx) : host;
  };
  /** A list entry matches when it names this exact host:port, or (no port in the entry) this hostname. */
  const listed = (host: string): boolean =>
    allowed.some((entry) => entry === host || (!/:\d+$/.test(entry) && hostnameOf(entry) === hostnameOf(host)));
  return (rawHost) => {
    const host = rawHost.toLowerCase();
    return loopback.has(host) || (opts.remoteAuth === true && listed(host));
  };
}
