import { nanoid } from "nanoid";
import type { Db } from "./db/db.js";

export type MemberRole = "owner" | "member";
export type Member = { userId: string; displayName: string | null; role: MemberRole; removedAt: string | null };
export type MemberEvent = {
  id: string; workspaceId: string | null; userId: string;
  kind: "added" | "removed" | "role_changed" | "renamed";
  actorUserId: string | null; detail: unknown; createdAt: string;
};
export class MemberError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export async function listMembers(db: Db, workspaceId: string): Promise<Member[]> {
  const rows = await db.query<{ user_id: string; display_name: string | null; role: MemberRole; removed_at: Date | string | null }>(
    `select m.user_id,u.display_name,m.role,m.removed_at from workspace_members m
     join users u on u.id=m.user_id where m.workspace_id=$1 order by m.added_at,m.user_id`, [workspaceId]);
  return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, role: r.role, removedAt: r.removed_at ? new Date(r.removed_at).toISOString() : null }));
}
export async function activeMembers(db: Db, workspaceId: string): Promise<Member[]> {
  return (await listMembers(db, workspaceId)).filter(m => m.removedAt === null);
}
export async function activeMemberCount(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db.query<{ n: number }>("select count(*)::int as n from workspace_members where workspace_id=$1 and removed_at is null", [workspaceId]);
  return row!.n;
}
export async function requireMember(db: Db, workspaceId: string, actorUserId: string, owner = false): Promise<void> {
  const [row] = await db.query<{ role: MemberRole }>("select role from workspace_members where workspace_id=$1 and user_id=$2 and removed_at is null", [workspaceId, actorUserId]);
  if (!row || (owner && row.role !== "owner")) throw new MemberError(403, "membership forbidden");
}
async function audit(db: Db, workspaceId: string | null, userId: string, kind: MemberEvent["kind"], actorUserId: string, detail: unknown = null) {
  await db.query("insert into member_events(id,workspace_id,user_id,kind,actor_user_id,detail) values ($1,$2,$3,$4,$5,$6::jsonb)",
    [`mev_${nanoid(16)}`, workspaceId, userId, kind, actorUserId, JSON.stringify(detail)]);
}
/** Serialize roster writes per workspace so simultaneous removals cannot lose the last owner. */
async function manage<T>(db: Db, workspaceId: string, actorUserId: string, fn: (t: Db) => Promise<T>): Promise<T> {
  return db.tx(async t => {
    await t.query("select id from workspaces where id=$1 for update", [workspaceId]);
    await requireMember(t, workspaceId, actorUserId, true);
    return fn(t);
  });
}
async function member(db: Db, workspaceId: string, userId: string): Promise<Member> {
  const found = (await listMembers(db, workspaceId)).find(m => m.userId === userId);
  if (!found) throw new MemberError(404, "member not found");
  return found;
}
function checkRole(role: MemberRole) {
  if (role !== "owner" && role !== "member") throw new MemberError(400, "invalid role");
}
export async function addMember(db: Db, workspaceId: string, userId: string, role: MemberRole, actorUserId: string): Promise<Member> {
  checkRole(role);
  return manage(db, workspaceId, actorUserId, async t => {
    if (!(await t.query("select id from users where id=$1", [userId]))[0]) throw new MemberError(404, "user not found");
    const rows = await t.query(`insert into workspace_members(workspace_id,user_id,role,added_by) values ($1,$2,$3,$4)
      on conflict (workspace_id,user_id) do update set role=excluded.role,added_at=now(),added_by=excluded.added_by,removed_at=null,removed_by=null
      where workspace_members.removed_at is not null returning user_id`, [workspaceId, userId, role, actorUserId]);
    if (!rows[0]) throw new MemberError(409, "member already active");
    await audit(t, workspaceId, userId, "added", actorUserId);
    return member(t, workspaceId, userId);
  });
}
async function guardLastOwner(db: Db, workspaceId: string, target: Member) {
  if (target.removedAt !== null) throw new MemberError(409, "member is removed");
  if (target.role === "owner") {
    const rows = await db.query("select user_id from workspace_members where workspace_id=$1 and role='owner' and removed_at is null", [workspaceId]);
    if (rows.length <= 1) throw new MemberError(409, "last owner must remain");
  }
}
export async function changeRole(db: Db, workspaceId: string, userId: string, role: MemberRole, actorUserId: string): Promise<Member> {
  checkRole(role);
  return manage(db, workspaceId, actorUserId, async t => {
    const target = await member(t, workspaceId, userId);
    if (target.removedAt !== null) throw new MemberError(409, "member is removed");
    if (target.role === role) return target;
    await guardLastOwner(t, workspaceId, target);
    await t.query("update workspace_members set role=$3 where workspace_id=$1 and user_id=$2", [workspaceId, userId, role]);
    await audit(t, workspaceId, userId, "role_changed", actorUserId, { from: target.role, to: role });
    return member(t, workspaceId, userId);
  });
}
export async function removeMember(db: Db, workspaceId: string, userId: string, actorUserId: string): Promise<Member> {
  return manage(db, workspaceId, actorUserId, async t => {
    await guardLastOwner(t, workspaceId, await member(t, workspaceId, userId));
    await t.query("update workspace_members set removed_at=now(),removed_by=$3 where workspace_id=$1 and user_id=$2", [workspaceId, userId, actorUserId]);
    await audit(t, workspaceId, userId, "removed", actorUserId);
    return member(t, workspaceId, userId);
  });
}
export async function listMemberEvents(db: Db, workspaceId: string): Promise<MemberEvent[]> {
  const rows = await db.query<{ id: string; workspace_id: string | null; user_id: string; kind: MemberEvent["kind"]; actor_user_id: string | null; detail: unknown; created_at: Date | string }>(
    "select id,workspace_id,user_id,kind,actor_user_id,detail,created_at from member_events where workspace_id=$1 order by created_at desc,id desc", [workspaceId]);
  return rows.map(r => ({ id: r.id, workspaceId: r.workspace_id, userId: r.user_id, kind: r.kind, actorUserId: r.actor_user_id, detail: r.detail, createdAt: new Date(r.created_at).toISOString() }));
}
export async function getUser(db: Db, userId: string): Promise<{ userId: string; displayName: string | null }> {
  const [row] = await db.query<{ display_name: string | null }>("select display_name from users where id=$1", [userId]);
  if (!row) throw new MemberError(404, "user not found");
  return { userId, displayName: row.display_name };
}
export async function renameUser(db: Db, userId: string, displayName: string | null) {
  const name = displayName === null ? null : displayName.trim();
  if (name !== null && (Array.from(name).length < 1 || Array.from(name).length > 64 || name.includes("\0"))) throw new MemberError(400, "invalid display name");
  return db.tx(async t => {
    await t.query("select id from users where id=$1 for update", [userId]);
    const prior = await getUser(t, userId);
    await t.query("update users set display_name=$2 where id=$1", [userId, name]);
    await audit(t, null, userId, "renamed", userId, { from: prior.displayName, to: name });
    return { userId, displayName: name };
  });
}
