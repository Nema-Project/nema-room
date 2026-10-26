"use client";

import { useEffect, useRef } from "react";
import { eventsUrl } from "./hub";
import type { HubEvent } from "./types";

type Subscriber = { onEvent: (event: HubEvent) => void; onReconnect?: () => void };
type Channel = { source: EventSource; opened: boolean; subscribers: Set<Subscriber> };
const channels = new Map<string, Channel>();

function subscribe(workspaceId: string, subscriber: Subscriber) {
  let channel = channels.get(workspaceId);
  if (!channel) {
    const source = new EventSource(eventsUrl(workspaceId));
    channel = { source, opened: false, subscribers: new Set() };
    channels.set(workspaceId, channel);
    const current = channel;
    source.onopen = () => {
      const reconnect = current.opened;
      current.opened = true;
      if (!reconnect) return;
      for (const item of [...current.subscribers]) {
        try { item.onReconnect?.(); } catch { /* one view cannot block other workspace subscribers */ }
      }
    };
    source.onmessage = (event: MessageEvent<string>) => {
      let parsed: HubEvent;
      try { parsed = JSON.parse(event.data) as HubEvent; } catch { return; }
      for (const item of [...current.subscribers]) {
        try { item.onEvent(parsed); } catch { /* one view cannot block delivery to sibling views */ }
      }
    };
  }
  channel.subscribers.add(subscriber);
  return () => {
    const current = channels.get(workspaceId);
    if (!current) return;
    current.subscribers.delete(subscriber);
    if (current.subscribers.size === 0) {
      current.source.close();
      channels.delete(workspaceId);
    }
  };
}

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
    const subscriber: Subscriber = { onEvent: (event) => handler.current(event), onReconnect: () => reconnect.current?.() };
    return subscribe(workspaceId, subscriber);
  }, [workspaceId]);
}
