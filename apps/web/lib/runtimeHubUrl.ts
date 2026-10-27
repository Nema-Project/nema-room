const DEFAULT_HUB_URL = "http://127.0.0.1:4400";

/**
 * Hub origin the browser should call. Read indirectly so Next does not inline the
 * value at `next build`; the container sets `NEMA_HUB_URL` when it starts.
 */
export function runtimeHubUrl(): string {
  const env = process.env;
  const raw = env.NEMA_HUB_URL || env.NEXT_PUBLIC_HUB_URL || DEFAULT_HUB_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_HUB_URL;
    if (url.username || url.password) return DEFAULT_HUB_URL;
    return url.origin;
  } catch {
    return DEFAULT_HUB_URL;
  }
}
