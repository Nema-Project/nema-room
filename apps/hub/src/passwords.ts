// Password hashing for the #167 remote form (D-3): argon2id, OWASP baseline parameters.
// The implementation is hash-wasm (pure WebAssembly): the hub ships in three runtimes —
// the Compose image, the npm-bundled CLI and the desktop's embedded hub — and its
// dependency set is deliberately native-free (PGlite is wasm for the same reason), so a
// native argon2 binding would need per-platform binaries in two of the three. All three
// candidate libraries were smoke-tested on 2026-11-24 and produce identical PHC strings;
// hash-wasm is the one that keeps the single-build property. Only hashes are stored.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { argon2id } from "hash-wasm";

export const ARGON2ID_PARAMS = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
export const MAX_PASSWORD_BYTES = 1024;

const HASH_BYTES = 32;
const SALT_BYTES = 16;

type Params = { memoryKiB: number; iterations: number; parallelism: number };

function passwordBytes(password: string): Buffer {
  return Buffer.from(password, "utf8");
}

function checkPasswordSize(bytes: Buffer): void {
  if (bytes.length === 0) throw new Error("password must not be empty");
  if (bytes.length > MAX_PASSWORD_BYTES) throw new Error(`password too long (max ${MAX_PASSWORD_BYTES} bytes)`);
}

export async function hashPassword(password: string, params: Params = ARGON2ID_PARAMS): Promise<string> {
  const bytes = passwordBytes(password);
  checkPasswordSize(bytes);
  const encoded = await argon2id({
    password: bytes,
    salt: randomBytes(SALT_BYTES),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: HASH_BYTES,
    outputType: "encoded",
  });
  // PHC strings carry no base64 padding; hash-wasm may append it.
  return encoded.replace(/=+\$/, "$").replace(/=+$/, "");
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const bytes = passwordBytes(password);
    if (bytes.length === 0 || bytes.length > MAX_PASSWORD_BYTES) return false;
    const match = PHC.exec(stored);
    if (!match) return false;
    const [, m, t, p, saltB64, hashB64] = match;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await argon2id({
      password: bytes,
      salt,
      parallelism: Number(p),
      iterations: Number(t),
      memorySize: Number(m),
      hashLength: expected.length,
      outputType: "binary",
    });
    return timingSafeEqual(Buffer.from(actual), expected);
  } catch {
    return false;
  }
}
