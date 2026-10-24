import path from "node:path";
import { readSecretLine, readStdinLine, saveSecretLine, SecretFileError } from "../secrets/file.js";
import type { Out } from "./authCommands.js";
import type { StoredAuth } from "./authStore.js";
import type { TokenSource } from "./transport.js";

const INVALID_KEY = "key 必须是一行非空文本";
const SYMLINK_KEY = "BYOK key 文件是符号链接，已拒绝。";
const MISSING_KEY = "没有 BYOK API key。请把钥匙从标准输入交给 nema auth byok。";
const KEY_MODE = "BYOK key 文件权限必须是 0600";
const INVALID_STORED_KEY = "BYOK key 文件内容无效。请重新把钥匙从标准输入交给 nema auth byok。";

/** Keeps BYOK's own wording for the helpers' generic errors. */
function byokError(e: unknown): unknown {
  if (!(e instanceof SecretFileError)) return e;
  return new Error(e.kind === "invalid" ? INVALID_KEY : e.kind === "symlink" ? SYMLINK_KEY : KEY_MODE);
}

export const byokKeyPath = (nemaHome: string): string => path.join(nemaHome, "byok-key");

export function saveByokKey(nemaHome: string, key: string): void {
  try {
    saveSecretLine(byokKeyPath(nemaHome), key);
  } catch (e) {
    throw byokError(e);
  }
}

export function readByokKey(nemaHome: string): string {
  try {
    return readSecretLine(byokKeyPath(nemaHome), MISSING_KEY, INVALID_STORED_KEY);
  } catch (e) {
    throw byokError(e);
  }
}

export class ByokTokenSource implements TokenSource {
  constructor(private readonly nemaHome: string) {}

  async getAccessToken(_opts: { force?: boolean; rejectedAccessToken?: string; signal?: AbortSignal } = {}): Promise<{ accessToken: string; auth: StoredAuth }> {
    const accessToken = readByokKey(this.nemaHome);
    return {
      accessToken,
      auth: {
        version: 1,
        mode: "byok",
        clientId: "",
        tokens: { access_token: accessToken, refresh_token: "" },
        lastRefresh: "",
      },
    };
  }

  async recordAuthError(_reason: { code: string; message: string }, _forAuth: StoredAuth): Promise<void> {}
}

export async function authByok(o: { nemaHome: string; out: Out; stdin: NodeJS.ReadableStream }): Promise<number> {
  const key = await readStdinLine(o.stdin);
  try {
    saveByokKey(o.nemaHome, key);
    o.out.log("已保存 BYOK API key");
    return 0;
  } catch (e) {
    o.out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
