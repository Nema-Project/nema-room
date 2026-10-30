"use client";

import { useEffect, useState } from "react";
import { listSkills } from "@/lib/hub";
import type { SkillRow } from "@/lib/slash";

const REUSE_MS = 30_000;
const cache = new Map<string, { at: number; rows: Promise<SkillRow[]> }>();

/** For tests. */
export function resetSkillMenuCache(): void {
  cache.clear();
}

function load(workspaceId: string, now: number): Promise<SkillRow[]> {
  const hit = cache.get(workspaceId);
  if (hit && now - hit.at < REUSE_MS) return hit.rows;
  // Any failure, or an older daemon, leaves only the built-in commands.
  const rows = Promise.resolve()
    .then(() => listSkills(workspaceId))
    .then((r) => (r?.supported && Array.isArray(r.skills) ? r.skills.map((s) => ({ id: s.id, description: s.description, command: s.command })) : []))
    .catch(() => [] as SkillRow[]);
  cache.set(workspaceId, { at: now, rows });
  return rows;
}

/**
 * The workspace's callable Skills for the `/` menu: fetched when the composer opens and again when the menu
 * opens after 30 seconds. Without a workspace there are none.
 */
export function useSkillRows(workspaceId: string | undefined, menuWanted: boolean): SkillRow[] {
  const [rows, setRows] = useState<SkillRow[]>([]);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void load(workspaceId, Date.now()).then((next) => live && setRows(next));
    return () => {
      live = false;
    };
  }, [workspaceId, menuWanted]);
  return workspaceId ? rows : [];
}
