"use client";

import { useEffect, useState } from "react";
import type { MessageMention } from "@nema/shared";
import { getMe, listMembers, type WorkspaceMember } from "@/lib/hub";

/** The local user of Phase 1 (#163 D-3): a null display name is shown with the localized "me". */
export const LOCAL_USER_ID = "usr_local";

/** A workspace roster (removed members included) and who "me" is. Empty means a single-member workspace. */
export type Roster = { members: WorkspaceMember[]; me: string | null };
export const EMPTY_ROSTER: Roster = { members: [], me: null };

/** How long a loaded roster is reused. Phase 1 has no UI that changes membership, so this only bounds staleness. */
const ROSTER_TTL_MS = 60_000;
const cache = new Map<string, { at: number; roster: Promise<Roster> }>();

/** Fetches a roster once for every message of a workspace. An older hub without the routes reads as single-member. */
function loadRoster(workspaceId: string): Promise<Roster> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.roster;
  const roster = Promise.all([Promise.resolve().then(() => listMembers(workspaceId)), Promise.resolve().then(() => getMe())])
    .then(([members, me]): Roster => ({ members: Array.isArray(members) ? members : [], me: me?.userId ?? null }))
    .catch(() => {
      cache.delete(workspaceId);
      return EMPTY_ROSTER;
    });
  cache.set(workspaceId, { at: Date.now(), roster });
  return roster;
}

/** Drops every cached roster, e.g. after the user renames themselves. */
export function invalidateRosters(): void {
  cache.clear();
}

/** The roster of one workspace; `EMPTY_ROSTER` until it loads, and when it cannot be loaded. */
export function useWorkspaceRoster(workspaceId: string | undefined): Roster {
  const [roster, setRoster] = useState<Roster>(EMPTY_ROSTER);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void loadRoster(workspaceId).then((next) => {
      if (live) setRoster(next);
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return roster;
}

export function activeMemberCount(roster: Roster): number {
  return roster.members.filter((m) => m.removedAt === null).length;
}

/** A user's name as the UI shows it: their display name, "me" for the local user without one, else the id. */
export function memberName(userId: string, displayName: string | null, me: string): string {
  if (displayName !== null) return displayName;
  return userId === LOCAL_USER_ID ? me : userId;
}

export type AuthorLabel = { kind: "you" } | { kind: "unknown" } | { kind: "member"; userId: string; displayName: string | null; removed: boolean };

/**
 * Who a user message shows as (#163 D-4, D-7). With fewer than two active members every user message is "you",
 * exactly as before. With two or more: your own messages are "you", a null author is "author not recorded",
 * and anyone else shows their name, marked when they have been removed.
 */
export function authorLabel(roster: Roster, authorUserId: string | null | undefined): AuthorLabel {
  if (activeMemberCount(roster) < 2) return { kind: "you" };
  if (authorUserId == null) return { kind: "unknown" };
  if (authorUserId === roster.me) return { kind: "you" };
  const member = roster.members.find((m) => m.userId === authorUserId);
  return { kind: "member", userId: authorUserId, displayName: member?.displayName ?? null, removed: member ? member.removedAt !== null : true };
}

/** Member mentions in a stored message whose member is no longer active here. Their stored text is never rewritten. */
export function removedMemberMentions(roster: Roster, mentions: readonly MessageMention[]): MessageMention[] {
  if (roster.members.length === 0) return [];
  const active = new Set(roster.members.filter((m) => m.removedAt === null).map((m) => m.userId));
  return mentions.filter((m) => m.type === "member" && !active.has(m.id));
}
