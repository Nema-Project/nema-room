import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHubEvents } from "@/lib/useHubEvents";
import { FakeEventSource } from "./FakeEventSource";
import type { HubEvent } from "@/lib/types";

function Probe({ workspaceId, onEvent, onReconnect }: { workspaceId: string; onEvent: (event: HubEvent) => void; onReconnect: () => void }) {
  useHubEvents(workspaceId, onEvent, onReconnect);
  return null;
}

describe("workspace event subscriptions", () => {
  beforeEach(() => { FakeEventSource.reset(); vi.stubGlobal("EventSource", FakeEventSource); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("multiplexes subscribers per workspace and delivers every frame to each", () => {
    const first = vi.fn(); const second = vi.fn(); const reconnect1 = vi.fn(); const reconnect2 = vi.fn();
    render(<><Probe workspaceId="w1" onEvent={first} onReconnect={reconnect1} /><Probe workspaceId="w1" onEvent={second} onReconnect={reconnect2} /><Probe workspaceId="w2" onEvent={vi.fn()} onReconnect={vi.fn()} /></>);
    expect(FakeEventSource.instances).toHaveLength(2);
    const source = FakeEventSource.forWorkspace("w1")!;
    source.open();
    const event: HubEvent = { type: "daemon.status", connected: true };
    source.send(event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
    source.open();
    expect(reconnect1).toHaveBeenCalledTimes(1);
    expect(reconnect2).toHaveBeenCalledTimes(1);
  });
});
