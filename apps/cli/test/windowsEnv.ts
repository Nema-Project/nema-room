/**
 * Variables a Windows child receives although the parent passed an explicit env: the ones
 * `windowsRuntimeEnv` forwards on purpose, plus the profile variables libuv/Windows add themselves
 * (observed with an env holding only PATH, HOME and the runtime variables).
 */
const WINDOWS_CHILD_ENV = [
  "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP",
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
];

/** The env keys a child may see when the caller explicitly passed `explicit`; Windows keys compare case-insensitively. */
export function allowedChildEnv(explicit: string[]): string[] {
  return process.platform === "win32" ? [...explicit, ...WINDOWS_CHILD_ENV] : explicit;
}

/** Keys in `actual` that are neither explicit nor expected OS additions. */
export function unexpectedEnvKeys(actual: string[], explicit: string[]): string[] {
  const allowed = new Set(allowedChildEnv(explicit).map((key) => (process.platform === "win32" ? key.toLowerCase() : key)));
  return actual.filter((key) => !allowed.has(process.platform === "win32" ? key.toLowerCase() : key)).sort();
}

/** Git may check text out with CRLF (core.autocrlf in the user's config); compare content, not line endings. */
export const lf = (text: string): string => text.replace(/\r\n/g, "\n");
