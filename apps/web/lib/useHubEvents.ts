"use client";

import { useEffect, useRef } from "react";
import { eventsUrl } from "./hub";
import type { HubEvent } from "./types";

/**
 * Subscribes to a workspace's SSE stream (which also carries global events such as daemon.status).
 * The hub has no workspace-less stream, so with `workspaceId === null` there is nothing to connect to
 * and the caller must pick a workspace id (any existing one) to receive global events.
 */
export function useHubEvents(workspaceId: string | null, onEvent: (e: HubEvent) => void, onReconnect?: () => void): void {
  const handler = useRef(onEvent);
  const reconnect = useRef(onReconnect);
  useEffect(() => {
    handler.current = onEvent;
    reconnect.current = onReconnect;
  });

  useEffect(() => {
    if (workspaceId === null || typeof EventSource === "undefined") return;
    const source = new EventSource(eventsUrl(workspaceId)); // EventSource reconnects on its own
    let opened = false;
    // Events missed while the stream was down are lost, so every open after the first signals a resync.
    source.onopen = () => {
      if (opened) reconnect.current?.();
      opened = true;
    };
    source.onmessage = (m: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(m.data) as HubEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => source.close();
  }, [workspaceId]);
}
