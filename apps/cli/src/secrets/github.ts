import path from "node:path";
import type { Out } from "../direct/authCommands.js";
import { readSecretLine, readStdinLine, saveSecretLine } from "./file.js";

const MISSING_TOKEN = "未保存 GitHub 令牌：请运行 nema auth github";
const INVALID_STORED_TOKEN = "GitHub 令牌文件内容无效。请重新把令牌从标准输入交给 nema auth github。";

export const githubTokenPath = (nemaHome: string): string => path.join(nemaHome, "github-token");

export function saveGithubToken(nemaHome: string, token: string): void {
  saveSecretLine(githubTokenPath(nemaHome), token);
}

export function readGithubToken(nemaHome: string): string {
  return readSecretLine(githubTokenPath(nemaHome), MISSING_TOKEN, INVALID_STORED_TOKEN);
}

/** `nema auth github`: reads one line from stdin. Never prints the token. */
export async function authGithub(o: { nemaHome: string; out: Out; stdin: NodeJS.ReadableStream }): Promise<number> {
  const token = await readStdinLine(o.stdin);
  try {
    saveGithubToken(o.nemaHome, token);
    o.out.log("已保存 GitHub 令牌");
    return 0;
  } catch (e) {
    o.out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
