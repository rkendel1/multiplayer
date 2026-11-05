/** Write helpers shared by function modules (workspace entry, the directory, channel membership). */
import { activity, channelMembers, channels, messages, participants } from "./app.js";

type W = { db: { find(c: any, f?: any): Promise<any[]>; insert(c: any, v: any): Promise<string> } };
type R = { db: { find(c: any, f?: any): Promise<any[]>; get(c: any, id: string): Promise<any> } };
type Members = { tenancy: { members(): Promise<Array<{ principalId: string; type: string; role: string }>> } };

const DEFAULT_CHANNELS = [["general", "Company-wide announcements and work-based matters"], ["random", "Non-work banter and water cooler conversation"]] as const;

/**
 * The application's side of joining the session's workspace (who may be in it is FeltKit's
 * membership): the first time, a person (not a guest or an agent) joins its default channels, and the
 * join is recorded in the activity log, which is also what marks it done. Returns true the first time.
 */
export async function enterWorkspace(ctx: W, workspaceId: string, participant: { id: string; displayName: string }, role: string): Promise<boolean> {
  if ((await ctx.db.find(activity, { type: "membership.joined", subjectId: participant.id })).length) return false;
  if (role !== "agent" && role !== "guest") {
    for (const c of await ctx.db.find(channels, { isDefault: true })) await joinChannel(ctx, workspaceId, c.id, participant.id);
  }
  await ctx.db.insert(activity, { workspaceId, actorId: participant.id, type: "membership.joined", summary: `${participant.displayName} joined as ${role}`, subjectId: participant.id, at: Date.now() });
  return true;
}

/**
 * The workspace directory: participants who are in the session's workspace. People and agents are
 * FeltKit's current members (ctx.tenancy.members(), live: a removed member is gone at once) that
 * have a profile; sample personas, who have no principal and so cannot be members, are in the
 * workspace's conversations. For mentions, DMs, channel invitations and presence.
 */
export async function directory(ctx: R & Members): Promise<any[]> {
  const out = new Map<string, any>();
  for (const m of await ctx.tenancy.members()) {
    const [p] = await ctx.db.find(participants, { principalId: m.principalId });
    if (p) out.set(p.id, p);
  }
  for (const cm of await ctx.db.find(channelMembers, {})) {
    if (out.has(cm.participantId)) continue;
    const p = await ctx.db.get(participants, cm.participantId);
    if (p?.persona) out.set(p.id, p);
  }
  return [...out.values()];
}

/** Whether a participant is in the session's workspace (see directory). */
export async function inWorkspace(ctx: R & Members, participant: { id: string; principalId: string; persona?: boolean }): Promise<boolean> {
  if (participant.persona) return (await ctx.db.find(channelMembers, { participantId: participant.id })).length > 0;
  return (await ctx.tenancy.members()).some((m) => m.principalId === participant.principalId);
}

/** A new workspace's default channels (#general, #random), created by the first person to work in it. */
export async function ensureDefaultChannels(ctx: W, workspaceId: string, createdBy: string): Promise<boolean> {
  if ((await ctx.db.find(channels, { isDefault: true })).length) return false;
  for (const [name, topic] of DEFAULT_CHANNELS) {
    await ctx.db.insert(channels, { workspaceId, kind: "public", name, topic, createdBy, createdAt: Date.now(), isDefault: true });
  }
  return true;
}

export async function joinChannel(ctx: W, workspaceId: string, channelId: string, participantId: string) {
  const [existing] = await ctx.db.find(channelMembers, { channelId, participantId });
  if (existing) return existing.id as string;
  return ctx.db.insert(channelMembers, { workspaceId, channelId, participantId, lastReadSeq: 0, joinedAt: Date.now() });
}

/** Insert a message at the conversation's next sequence number. Callers have authorized the author. */
export async function insertMessage(
  ctx: W & { db: { sequence(name: string): Promise<number>; get(c: any, id: string): Promise<any>; patch(c: any, id: string, v: any): Promise<any> } },
  channel: { id: string; workspaceId: string },
  authorId: string,
  fields: { text: string; root?: { id: string; replyCount: number } | null; mentions?: string[]; attachments?: any[]; sharedObjectId?: string },
) {
  const seq = await ctx.db.sequence(`msg:${channel.id}`);
  const now = Date.now();
  const id = await ctx.db.insert(messages, {
    workspaceId: channel.workspaceId, channelId: channel.id, seq, authorId, text: fields.text,
    ...(fields.root ? { rootId: fields.root.id } : {}), topLevel: !fields.root, replyCount: 0,
    mentions: fields.mentions ?? [], attachments: fields.attachments ?? [],
    ...(fields.sharedObjectId ? { sharedObjectId: fields.sharedObjectId } : {}), createdAt: now,
  });
  if (fields.root) await ctx.db.patch(messages, fields.root.id, { replyCount: fields.root.replyCount + 1, lastReplyAt: now });
  const [member] = await ctx.db.find(channelMembers, { channelId: channel.id, participantId: authorId });
  if (member && member.lastReadSeq < seq) await ctx.db.patch(channelMembers, member.id, { lastReadSeq: seq });
  return { id, seq, now };
}

/** The application-owned room agent's principal id: its worker signs in with an agent session of this id. */
export const ROOM_AGENT = "assistant";

export async function ensureRoomAgent(ctx: W): Promise<string> {
  const [existing] = await ctx.db.find(participants, { principalId: ROOM_AGENT });
  if (existing) return existing.id;
  return ctx.db.insert(participants, {
    principalId: ROOM_AGENT, kind: "agent", agentType: "application", handle: ROOM_AGENT, displayName: "Assistant",
    title: "Room agent · summaries and project plans", createdAt: Date.now(),
  });
}
