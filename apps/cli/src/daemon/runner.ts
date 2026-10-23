import type { TaskAssign, TaskEvent } from "@nema/shared";
import { configErrorMessage, DEFAULT_CONFIG, type NemaConfig } from "../config.js";

export type AgentResult = { ok: true; reply: string } | { ok: false; error: string };

export interface AgentAdapter {
  name: string;
  run(task: TaskAssign, onEvent: (e: TaskEvent) => void): Promise<AgentResult>;
}

/** "auto" -> the configured adapter. "codex" and "codex-cli" are the retired CLI names; both run codex-direct. */
export function resolveAdapterName(requested: string, config: NemaConfig): string {
  if (requested === "auto") return config.adapter;
  if (requested === "codex" || requested === "codex-cli") return "codex-direct";
  return requested;
}

/** Runs tasks one at a time, globally, in enqueue order. */
export class Runner {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapters: AgentAdapter[],
    private readonly getConfig: () => NemaConfig = () => ({ ...DEFAULT_CONFIG }),
  ) {}

  get adapterNames(): string[] {
    return this.adapters.map((a) => a.name);
  }

  /**
   * Runs `job` in the same queue as tasks, so it never overlaps a running agent (e.g. removing a
   * workspace's isolation dir while Codex is still using it). Failures are swallowed.
   */
  exclusive(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job).catch(() => {});
    this.chain = run;
    return run;
  }

  enqueue(task: TaskAssign, onEvent: (e: TaskEvent) => void, onDone: (r: AgentResult) => void): void {
    this.chain = this.chain.then(async () => {
      let result: AgentResult;
      let name: string | undefined;
      try {
        name = resolveAdapterName(task.adapter, this.getConfig());
      } catch (e) {
        // config unreadable: fail loudly, never fall back to another adapter
        result = { ok: false, error: configErrorMessage(e) };
      }
      if (name !== undefined) {
        const adapter = this.adapters.find((a) => a.name === name);
        if (!adapter) {
          result = { ok: false, error: `adapter ${name} 不可用` };
        } else {
          try {
            result = await adapter.run(task, onEvent);
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
      }
      try {
        onDone(result!);
      } catch {
        // a failing completion callback must not stall the queue
      }
    });
  }
}
