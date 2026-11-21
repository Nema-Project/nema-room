"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThreadWindowsHandle } from "@/components/ThreadWindows";
import { mainMessageUrl } from "@/lib/threads";
import type { Message } from "@/lib/types";

type MainMessageHandler = (workspaceId: string, message: Message) => void;
export type ThreadWindowsContextValue = ThreadWindowsHandle & {
  registerMainMessageHandler: (handler: MainMessageHandler) => () => void;
};
const ThreadWindowsContext = createContext<ThreadWindowsContextValue | null>(null);

export function useThreadWindows(): ThreadWindowsContextValue {
  const context = useContext(ThreadWindowsContext);
  if (!context) throw new Error("useThreadWindows must be used within ThreadWindowsProvider");
  return context;
}

type ThreadWindowsComponent = (typeof import("@/components/ThreadWindows"))["ThreadWindows"];
type QueuedCall =
  | { kind: "open"; workspaceId: string; threadId: string; messageId?: string }
  | { kind: "focus"; workspaceId: string; threadId: string };

/** Owns floating thread windows above route pages so workspace changes do not destroy them. */
export function ThreadWindowsProvider({ children }: { children: ReactNode }) {
  const [HostComponent, setHostComponent] = useState<ThreadWindowsComponent | null>(null);
  // The handle object is recreated on every host render, so it lives in a ref;
  // hostReady only flips on the null-to-handle transition to trigger the flush.
  const hostRef = useRef<ThreadWindowsHandle | null>(null);
  const [hostReady, setHostReady] = useState(false);
  const loading = useRef<Promise<void> | null>(null);
  const pending = useRef<QueuedCall[]>([]);
  const mainMessageHandler = useRef<MainMessageHandler | null>(null);

  // The floating layer renders nothing until the first window opens, so its
  // chunk (ThreadWindows + ThreadView) stays out of the first-load set. It is
  // loaded with a plain import() rather than next/dynamic: the provider drives
  // the layer through its imperative handle, and next/dynamic's ref lands on
  // the loadable wrapper instead of the component, which would lose the
  // handle. Calls that arrive while the chunk loads are queued, never dropped;
  // a failed load clears the guard so the next open() retries.
  const startLoad = useCallback(() => {
    if (loading.current) return;
    loading.current = import("@/components/ThreadWindows")
      .then((mod) => {
        setHostComponent(() => mod.ThreadWindows);
      })
      .catch(() => {
        loading.current = null;
      });
  }, []);

  const setHost = useCallback((handle: ThreadWindowsHandle | null) => {
    hostRef.current = handle;
    setHostReady(handle !== null);
  }, []);

  // Deliver calls queued while the floating layer was still loading, in order.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || pending.current.length === 0) return;
    const queued = pending.current;
    pending.current = [];
    for (const call of queued) {
      if (call.kind === "open") host.open(call.workspaceId, call.threadId, call.messageId);
      else host.focus(call.workspaceId, call.threadId);
    }
  }, [hostReady]);

  const open = useCallback<ThreadWindowsHandle["open"]>(
    (workspaceId, threadId, messageId) => {
      const host = hostRef.current;
      if (host) host.open(workspaceId, threadId, messageId);
      else {
        pending.current.push({ kind: "open", workspaceId, threadId, messageId });
        startLoad();
      }
    },
    [startLoad],
  );
  const focus = useCallback<ThreadWindowsHandle["focus"]>((workspaceId, threadId) => {
    const host = hostRef.current;
    if (host) host.focus(workspaceId, threadId);
    // A focus target can only be a window an earlier open created; that open
    // either reached the host or is queued, so queue behind it. With neither,
    // there is no window to focus and the call is a no-op by definition.
    else if (pending.current.length > 0) pending.current.push({ kind: "focus", workspaceId, threadId });
  }, []);
  const registerMainMessageHandler = useCallback((handler: MainMessageHandler) => {
    mainMessageHandler.current = handler;
    return () => {
      if (mainMessageHandler.current === handler) mainMessageHandler.current = null;
    };
  }, []);
  const openMainMessage = useCallback((workspaceId: string, message: Message) => {
    if (mainMessageHandler.current) mainMessageHandler.current(workspaceId, message);
    else if (typeof window !== "undefined") window.location.assign(mainMessageUrl(workspaceId, message.id));
  }, []);
  const value = useMemo(() => ({ open, focus, registerMainMessageHandler }), [open, focus, registerMainMessageHandler]);
  return (
    <ThreadWindowsContext.Provider value={value}>
      {children}
      {HostComponent && <HostComponent ref={setHost} onOpenMainMessage={openMainMessage} />}
    </ThreadWindowsContext.Provider>
  );
}
