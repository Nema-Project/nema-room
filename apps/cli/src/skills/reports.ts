// Activation reports go to the hub in the background; a task waits for them, briefly, before it ends.

/** Starts tracking a report: a rejection is kept for `settleReports` and never left unhandled meanwhile. */
export function trackReport(list: Promise<unknown>[], report: Promise<unknown>): void {
  report.catch(() => {});
  list.push(report);
}

/** Waits for `promises` up to `timeoutMs`: `timedOut` when some were still running, `failed` counts rejections. */
export async function settleReports(promises: Promise<unknown>[], timeoutMs: number): Promise<{ timedOut: boolean; failed: number }> {
  let failed = 0;
  const all = Promise.all(promises.map((p) => p.then(() => {}, () => void failed++)));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)));
  try {
    const outcome = await Promise.race([all.then(() => "done" as const), timeout]);
    return { timedOut: outcome === "timeout", failed };
  } finally {
    clearTimeout(timer);
  }
}
