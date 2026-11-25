"use client";

import { useCallback, useRef, useState } from "react";
import { getActiveTask } from "./hub";
import type { HubEvent, Task } from "./types";

type Progress = Extract<HubEvent, { type: "task.progress" }>;
type Activity = { task: Task | null; progress: Progress | null };

export function useTaskActivity(workspaceId: string, threadId: string | null) {
  const [activity, setActivity] = useState<Activity>({ task: null, progress: null });
  const pendingSnapshot = useRef<Set<string> | null>(null);

  const setTask = useCallback((task: Task | null) => {
    const matching = task?.workspaceId === workspaceId && task.threadId === threadId ? task : null;
    setActivity((current) => ({
      task: matching,
      progress: matching && current.progress?.taskId === matching.id ? current.progress : null,
    }));
  }, [workspaceId, threadId]);

  const loadActive = useCallback(async () => {
    // A later start supersedes this snapshot. Completion only invalidates the task it names.
    const retired = new Set<string>();
    pendingSnapshot.current = retired;
    try {
      const snapshot = await getActiveTask(workspaceId);
      const { running } = snapshot;
      if (pendingSnapshot.current === retired && (!running || !retired.has(running.id))) setTask(running);
      return snapshot;
    } catch {
      // Keep the current indicator until a later event or successful resync.
    } finally {
      if (pendingSnapshot.current === retired) pendingSnapshot.current = null;
    }
  }, [workspaceId, setTask]);

  const handleTaskEvent = useCallback((event: HubEvent) => {
    if (event.type === "task.progress" && event.threadId === threadId) {
      // Progress can arrive after a view subscribes but before its HTTP snapshot resolves.
      setActivity((current) => current.task && current.task.id !== event.taskId ? current : { ...current, progress: event });
      return;
    }

    let stoppedId: string | null = null;
    if (event.type === "task.updated" && event.task.workspaceId === workspaceId) {
      if (event.task.status === "running") {
        pendingSnapshot.current = null;
        setTask(event.task);
        return;
      }
      stoppedId = event.task.id;
    } else if (event.type === "message.created" && event.message.workspaceId === workspaceId && event.message.role !== "user") {
      // A final reply can be routed into a newly created thread, so clear by task id.
      stoppedId = event.message.taskId;
    }

    if (stoppedId === null) return;
    pendingSnapshot.current?.add(stoppedId);
    setActivity((current) => {
      if (current.task?.id === stoppedId) return { task: null, progress: null };
      if (current.progress?.taskId === stoppedId) return { ...current, progress: null };
      return current;
    });
  }, [workspaceId, threadId, setTask]);

  const runningTask = activity.task?.workspaceId === workspaceId && activity.task.threadId === threadId ? activity.task : null;
  const progress = runningTask && activity.progress?.taskId === runningTask.id && activity.progress.threadId === threadId
    ? activity.progress.text
    : "";
  return { runningTask, progress, loadActive, handleTaskEvent };
}
