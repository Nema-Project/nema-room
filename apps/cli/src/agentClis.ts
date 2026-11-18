// Agent CLIs (Codex, Claude Code) are never bundled or installed by Nema (#132 D-6 = A): this only reports
// whether one answers `--version` on PATH and, when not, where its official install instructions live.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandSpec } from "./platform.js";

const execFileAsync = promisify(execFile);

export type AgentCliId = "codex" | "claude-code";

export type AgentCliStatus = {
  id: AgentCliId;
  /** The command looked up on PATH. */
  command: string;
  installed: boolean;
  /** First line of `--version` when installed. */
  version: string | null;
  /** The vendor's own install instructions; Nema links to them and never runs an installer. */
  installUrl: string;
};

export const AGENT_CLIS: ReadonlyArray<{ id: AgentCliId; command: string; installUrl: string }> = [
  { id: "codex", command: "codex", installUrl: "https://developers.openai.com/codex/cli" },
  { id: "claude-code", command: "claude", installUrl: "https://code.claude.com/docs/en/setup" },
];

export type VersionRunner = (command: string) => Promise<string>;

const runVersion: VersionRunner = async (command) => {
  const spec = commandSpec(command, ["--version"]);
  const { stdout } = await execFileAsync(spec.bin, spec.args, { timeout: 10_000, windowsHide: true });
  return stdout;
};

/** One `--version` per CLI, in parallel. A CLI that is missing, times out or fails counts as not installed. */
export async function detectAgentClis(run: VersionRunner = runVersion): Promise<AgentCliStatus[]> {
  return Promise.all(
    AGENT_CLIS.map(async ({ id, command, installUrl }) => {
      try {
        const version = (await run(command)).trim().split(/\r?\n/)[0]?.trim() ?? "";
        return { id, command, installed: true, version: version === "" ? null : version, installUrl };
      } catch {
        return { id, command, installed: false, version: null, installUrl };
      }
    }),
  );
}
