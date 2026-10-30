// `nema daemon` runs until it is stopped from a terminal (Ctrl-C), a service manager (SIGTERM) or
// a closed session (SIGHUP). Without a handler Node exits at once, and stdio MCP servers, which lead
// their own process groups, would outlive it. So a signal closes the daemon first.

export type SignalOptions = {
  close: () => Promise<void>;
  on?: (signal: NodeJS.Signals, handler: () => void) => void;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /** How long a close may take before the daemon exits anyway. */
  timeoutMs?: number;
};

export function stopOnSignals(o: SignalOptions): void {
  const on = o.on ?? ((signal, handler) => { process.on(signal, handler); });
  const exit = o.exit ?? ((code) => process.exit(code));
  const log = o.log ?? ((line) => console.error(line));
  const timeoutMs = o.timeoutMs ?? 15_000;
  let stopping = false;
  let done = false;
  const finish = (code: number) => {
    if (done) return;
    done = true;
    exit(code);
  };
  const handler = () => {
    if (stopping) {
      // A second signal: the person wants out now.
      log("nema daemon: stopping now");
      finish(130);
      return;
    }
    stopping = true;
    log("nema daemon: stopping (MCP servers and running tasks are stopped first; send the signal again to exit at once)");
    const timer = setTimeout(() => {
      log("nema daemon: stopping took too long; exiting");
      finish(1);
    }, timeoutMs);
    // Referenced on purpose: a hung close holds nothing else open, and Node would then end with 0.
    o.close().then(
      () => { clearTimeout(timer); finish(0); },
      (error: unknown) => {
        clearTimeout(timer);
        log(`nema daemon: stop failed: ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
      },
    );
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) on(signal, handler);
}
