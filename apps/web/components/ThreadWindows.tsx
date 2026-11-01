"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ThreadView } from "@/components/ThreadView";
import type { ThreadWindowHost } from "@/lib/threads";
import type { Message } from "@/lib/types";

type WindowItem = { workspaceId: string; threadId: string; messageId?: string; x: number; y: number };
export type ThreadWindowsHandle = ThreadWindowHost & { focus: (workspaceId: string, threadId: string) => void };

export const ThreadWindows = forwardRef<ThreadWindowsHandle, { onOpenMainMessage?: (workspaceId: string, message: Message) => void }>(function ThreadWindows({ onOpenMainMessage }, ref) {
  const [windows, setWindows] = useState<WindowItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; left: number; top: number } | null>(null);
  const windowElements = useRef(new Map<string, HTMLDivElement>());
  const key = (workspaceId: string, threadId: string) => `${workspaceId}:${threadId}`;
  const windowSize = useCallback(() => {
    return { width: Math.min(520, Math.max(1, window.innerWidth - 32)), height: Math.min(680, Math.max(1, window.innerHeight - 32)) };
  }, []);
  const boundedPosition = useCallback((x: number, y: number) => {
    const size = windowSize();
    return {
      x: Math.max(8, Math.min(window.innerWidth - size.width - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - size.height - 8, y)),
    };
  }, [windowSize]);
  function open(workspaceId: string, threadId: string, messageId?: string) {
    const id = key(workspaceId, threadId);
    setWindows((list) => {
      if (list.some((item) => key(item.workspaceId, item.threadId) === id)) return list.map((item) => key(item.workspaceId, item.threadId) === id && messageId ? { ...item, messageId } : item);
      const size = windowSize();
      const position = boundedPosition(window.innerWidth - size.width - 24 - list.length * 36, window.innerHeight - size.height - 24 - list.length * 36);
      return [...list, { workspaceId, threadId, messageId, ...position }];
    });
    setActive(id);
  }
  useImperativeHandle(ref, () => ({ open, focus: (workspaceId, threadId) => setActive(key(workspaceId, threadId)) }));
  useLayoutEffect(() => {
    const element = windowElements.current.get(active ?? "");
    if (element && !element.contains(document.activeElement)) element.focus({ preventScroll: true });
  }, [active, windows.length]);
  useEffect(() => {
    const updateActive = (event: Event) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".thread-floating") : null;
      setActive(element?.dataset.windowId ?? null);
    };
    document.addEventListener("pointerdown", updateActive, true);
    document.addEventListener("focusin", updateActive);
    return () => {
      document.removeEventListener("pointerdown", updateActive, true);
      document.removeEventListener("focusin", updateActive);
    };
  }, []);
  useEffect(() => {
    const resize = () => setWindows((list) => list.map((item) => ({ ...item, ...boundedPosition(item.x, item.y) })));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [boundedPosition]);
  function onPointerDown(e: PointerEvent<HTMLElement>, item: WindowItem) {
    if ((e.target as HTMLElement).closest("button")) return;
    const host = e.currentTarget.closest(".thread-floating") as HTMLElement | null;
    if (!host) return;
    drag.current = { id: key(item.workspaceId, item.threadId), x: e.clientX, y: e.clientY, left: item.x, top: item.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setActive(key(item.workspaceId, item.threadId));
  }
  function onPointerMove(e: PointerEvent<HTMLElement>) {
    if (!drag.current) return;
    const d = drag.current;
    const position = boundedPosition(d.left + e.clientX - d.x, d.top + e.clientY - d.y);
    setWindows((list) => list.map((item) => key(item.workspaceId, item.threadId) === d.id ? { ...item, ...position } : item));
  }
  function close(item: WindowItem) {
    const id = key(item.workspaceId, item.threadId);
    setWindows((list) => list.filter((x) => key(x.workspaceId, x.threadId) !== id));
    setActive((current) => current === id ? null : current);
  }
  return <div className="thread-windows">{windows.map((item, index) => {
    const id = key(item.workspaceId, item.threadId);
    return <div key={id} ref={(element) => { if (element) windowElements.current.set(id, element); else windowElements.current.delete(id); }} data-window-id={id} className={`thread-floating${active === id ? " active" : ""}`} style={{ left: `${item.x}px`, top: `${item.y}px`, zIndex: active === id ? 100 + windows.length : 50 + index }} onMouseDown={(e) => { setActive(id); if (e.target instanceof Element && e.target.closest("input, textarea, select, button, a, label, [contenteditable]")) return; e.currentTarget.focus(); }} onFocus={() => setActive(id)} onKeyDown={(e) => { if (e.key === "Escape" && active === id) close(item); }} tabIndex={-1}>
      <ThreadView workspaceId={item.workspaceId} threadId={item.threadId} focusMessageId={item.messageId} floating active={active === id} onClose={() => close(item)} onOpenThread={open} onOpenMainMessage={onOpenMainMessage} />
      <div className="thread-drag" onPointerDown={(e) => onPointerDown(e, item)} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} />
    </div>;
  })}</div>;
});
