"use client";

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { ThreadWindows, type ThreadWindowsHandle } from "@/components/ThreadWindows";
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

/** Owns floating thread windows above route pages so workspace changes do not destroy them. */
export function ThreadWindowsProvider({ children }: { children: ReactNode }) {
  const host = useRef<ThreadWindowsHandle>(null);
  const mainMessageHandler = useRef<MainMessageHandler | null>(null);
  const open = useCallback<ThreadWindowsHandle["open"]>((workspaceId, threadId, messageId) => {
    host.current?.open(workspaceId, threadId, messageId);
  }, []);
  const focus = useCallback<ThreadWindowsHandle["focus"]>((workspaceId, threadId) => {
    host.current?.focus(workspaceId, threadId);
  }, []);
  const registerMainMessageHandler = useCallback((handler: MainMessageHandler) => {
    mainMessageHandler.current = handler;
    return () => { if (mainMessageHandler.current === handler) mainMessageHandler.current = null; };
  }, []);
  const openMainMessage = useCallback((workspaceId: string, message: Message) => {
    if (mainMessageHandler.current) mainMessageHandler.current(workspaceId, message);
    else if (typeof window !== "undefined") window.location.assign(mainMessageUrl(workspaceId, message.id));
  }, []);
  const value = useMemo(() => ({ open, focus, registerMainMessageHandler }), [open, focus, registerMainMessageHandler]);
  return <ThreadWindowsContext.Provider value={value}>
    {children}
    <ThreadWindows ref={host} onOpenMainMessage={openMainMessage} />
  </ThreadWindowsContext.Provider>;
}
