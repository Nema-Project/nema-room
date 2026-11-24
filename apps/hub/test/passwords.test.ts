import { describe, expect, test } from "vitest";
import { ARGON2ID_PARAMS, MAX_PASSWORD_BYTES, hashPassword, verifyPassword } from "../src/passwords.js";

/** PHC string: $argon2id$v=19$m=<KiB>,t=<iterations>,p=<lanes>$<salt>$<hash> */
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

describe("passwords (#167, D-3 argon2id)", () => {
  test("parameters follow the OWASP argon2id baseline and are what the hash records", async () => {
    // OWASP Password Storage Cheat Sheet: argon2id, m=19 MiB, t=2, p=1 as the minimum configuration.
    expect(ARGON2ID_PARAMS).toEqual({ memoryKiB: 19456, iterations: 2, parallelism: 1 });
    const hash = await hashPassword("correct horse battery staple");
    const match = PHC.exec(hash);
    expect(match, hash).not.toBeNull();
    expect(match!.slice(1, 4).map(Number)).toEqual([ARGON2ID_PARAMS.memoryKiB, ARGON2ID_PARAMS.iterations, ARGON2ID_PARAMS.parallelism]);
  });

  test("the right password verifies and a wrong one does not", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  test("the same password hashes differently each time (salted)", async () => {
    const [a, b] = [await hashPassword("same password"), await hashPassword("same password")];
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  test("verification reads the parameters from the stored hash, so older parameters still verify", async () => {
    // A hash written with other parameters than today's constants (as an earlier release might have) must
    // still verify: the check follows the string, not ARGON2ID_PARAMS.
    const hash = await hashPassword("upgrade me", { memoryKiB: 8192, iterations: 1, parallelism: 1 });
    expect(PHC.exec(hash)!.slice(1, 4).map(Number)).toEqual([8192, 1, 1]);
    expect(await verifyPassword("upgrade me", hash)).toBe(true);
    expect(await verifyPassword("upgrade you", hash)).toBe(false);
  });

  test("non-ASCII passwords round-trip", async () => {
    const hash = await hashPassword("パスワード密码🔑");
    expect(await verifyPassword("パスワード密码🔑", hash)).toBe(true);
    expect(await verifyPassword("パスワード密码", hash)).toBe(false);
  });

  test("hashing refuses an empty or oversized password", async () => {
    await expect(hashPassword("")).rejects.toThrow(/empty/i);
    await expect(hashPassword("x".repeat(MAX_PASSWORD_BYTES + 1))).rejects.toThrow(/too long/i);
    // The limit is in UTF-8 bytes, not characters: 3-byte characters reach it sooner.
    await expect(hashPassword("密".repeat(Math.floor(MAX_PASSWORD_BYTES / 3) + 1))).rejects.toThrow(/too long/i);
    expect(PHC.test(await hashPassword("x".repeat(MAX_PASSWORD_BYTES)))).toBe(true);
  });

  test("verification answers false, never throws, for empty or oversized input and malformed hashes", async () => {
    const hash = await hashPassword("pw");
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("x".repeat(MAX_PASSWORD_BYTES + 1), hash)).toBe(false);
    for (const bad of ["", "pw", "$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", "$argon2id$garbage", "$2b$10$abcdefghijklmnopqrstuv"]) {
      expect(await verifyPassword("pw", bad), bad).toBe(false);
    }
  });
});
