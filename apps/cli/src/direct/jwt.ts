/** Decode a JWT payload without verifying the signature. Throws on malformed input. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("Malformed JWT");
  const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Malformed JWT payload");
  return payload as Record<string, unknown>;
}

/** The `exp` claim in seconds since the epoch, or null when absent or undecodable. */
export function jwtExp(token: string): number | null {
  try {
    const exp = decodeJwtPayload(token).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}
