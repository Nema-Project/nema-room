import { expect, test, vi } from "vitest";
import { Runner } from "../src/daemon/runner.js";

const mockSockets = vi.hoisted(() => [] as Array<any>);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: string[] = [];
    terminated = false;
    constructor(_url: string) { super(); mockSockets.push(this); }
    send(data: string) { this.sent.push(data); }
    terminate() { this.terminated = true; }
  }
  return { default: MockSocket };
});

test("close blocks late open, malformed messages, and stale send closures", async () => {
  mockSockets.length = 0;
  const { connectDaemon } = await import("../src/daemon/connection.js");
  const bound: Array<((message: unknown) => boolean) | null> = [];
  const daemon = connectDaemon({
    hubUrl: "http://fake.invalid", token: "token", runner: new Runner([]),
    bindSend: (send) => bound.push(send),
  });
  const socket = mockSockets.at(-1)!;
  const closing = daemon.close();
  expect(socket.terminated).toBe(true);
  socket.readyState = 1;
  socket.emit("open"); // queued open callback after close
  expect(bound.at(-1)).toBeNull();
  expect(socket.sent).toEqual([]);

  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  socket.emit("message", Buffer.from(JSON.stringify({ type: "task.assign", taskId: "late" })));
  expect(errors).not.toHaveBeenCalled();
  expect(socket.sent).toEqual([]);
  errors.mockRestore();

  socket.emit("close");
  await closing;

  const second = connectDaemon({
    hubUrl: "http://fake.invalid", token: "token", runner: new Runner([]),
    bindSend: (send) => bound.push(send),
  });
  const openedSocket = mockSockets.at(-1)!;
  openedSocket.readyState = 1;
  openedSocket.emit("open");
  const staleSend = bound.at(-1)!;
  const sentBeforeClose = openedSocket.sent.length;
  const secondClosing = second.close();
  expect(staleSend).not.toBeNull();
  expect(staleSend!({ type: "late" })).toBe(false);
  expect(openedSocket.sent).toHaveLength(sentBeforeClose);
  openedSocket.emit("close");
  await secondClosing;
});
