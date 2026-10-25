import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createOwnedHelperScope } from "../src/ownedHelpers.js";
import { runHelperFile, type OwnedHelperProcess } from "@nema/shared/ownedHelper";
import { git } from "@nema/knowledge";

function processHandle(closed: Promise<void>): OwnedHelperProcess {
  const exited = Promise.resolve({ code: 0, signal: null });
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    exited,
    closed: closed.then(() => ({ code: 0, signal: null })),
  };
}

describe("managed owned-helper scope", () => {
  test("shutdown waits for a helper whose guardian is still connecting", async () => {
    let releaseStart!: (child: OwnedHelperProcess) => void;
    let releaseClose!: () => void;
    const started = new Promise<OwnedHelperProcess>((resolve) => { releaseStart = resolve; });
    const closed = new Promise<void>((resolve) => { releaseClose = resolve; });
    let startupSignal: AbortSignal | undefined;
    const scope = createOwnedHelperScope("guardian.exe", (_command, _args, options) => {
      startupSignal = options?.signal;
      return started;
    });

    const pending = scope.spawn("git", ["status"]);
    await Promise.resolve();
    expect(startupSignal).toBeDefined();
    scope.stopAccepting();
    expect(startupSignal?.aborted).toBe(true);
    let drained = false;
    const draining = scope.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseStart(processHandle(closed));
    const child = await pending;
    expect(child.stdout).not.toBeNull();
    expect(drained).toBe(false);
    releaseClose();
    await draining;
    expect(drained).toBe(true);
  });

  test("shutdown refuses later helper starts", async () => {
    const scope = createOwnedHelperScope("guardian.exe", async () => processHandle(Promise.resolve()));
    scope.stopAccepting();
    await expect(scope.spawn("git", ["status"])).rejects.toThrow(/shutting down/i);
    await scope.drain();
  });

  test("KnowledgeStore Git calls use the injected per-runtime helper scope", async () => {
    let command = "";
    let args: string[] = [];
    const scope = createOwnedHelperScope("guardian.exe", async (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = new Promise<void>((resolve) => stdout.once("end", resolve));
      queueMicrotask(() => stdout.end("abc123\n"));
      return {
        stdin,
        stdout,
        stderr,
        kill: () => true,
        exited: closed.then(() => ({ code: 0, signal: null })),
        closed: closed.then(() => ({ code: 0, signal: null })),
      };
    });
    expect(await git("C:/repo", ["rev-parse", "HEAD"], scope)).toBe("abc123\n");
    expect(command).toBe("git");
    expect(args).toEqual(["rev-parse", "HEAD"]);
    scope.stopAccepting();
    await scope.drain();
  });

  test("buffered managed helpers forward Git stdin and collect the complete result", async () => {
    let received = "";
    const scope = createOwnedHelperScope("guardian.exe", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = new Promise<{ code: number; signal: null }>((resolve) => {
        stdin.setEncoding("utf8").on("data", (chunk: string) => { received += chunk; });
        stdin.on("end", () => {
          stdout.end(`read:${received}`);
          stderr.end();
          resolve({ code: 0, signal: null });
        });
      });
      return { stdin, stdout, stderr, kill: () => true, exited: closed, closed };
    });

    const result = await runHelperFile("git", ["patch-id", "--stable"], { input: Buffer.from("diff --git a/x b/x\n") }, scope);
    expect(result.error).toBeNull();
    expect(result.stdout.toString()).toBe("read:diff --git a/x b/x\n");
    expect(result.code).toBe(0);
    scope.stopAccepting();
    await scope.drain();
  });
});
