import { fail, s } from "@feltdb/feltkit";
import { app, channelMembers, channels, messages, participants } from "./app.js";
import { atLeast, me, readableChannels, loadChannel, loadWorkspace } from "./_authz.js";
import { inWorkspace, joinChannel } from "./_ops.js";
import { channelName, record } from "./_util.js";

const UNREAD_CAP = 99;

/** The sidebar: conversations the caller can see, with membership and unread counts. */
export const list = app.query({
  access: "channels.read",
  args: { workspaceId: s.optional(s.string()) },
  handler: async (ctx) => {
    const { participant, role } = await loadWorkspace(ctx);
    const visible = await readableChannels(ctx, participant.id, role);
    const mine = new Map((await ctx.db.find(channelMembers, { participantId: participant.id })).map((m) => [m.channelId, m]));
    const out = [];
    for (const c of visible) {
      const member = mine.get(c.id);
      let unread = 0;
      let mentions = 0;
      if (member) {
        const page = await ctx.db.query(messages, { where: [{ field: "channelId", eq: c.id }, { field: "seq", gt: member.lastReadSeq }], orderBy: [{ field: "seq", direction: "asc" }], limit: UNREAD_CAP + 1 });
        const fresh = page.records.filter((m) => m.topLevel && !m.deletedAt && m.authorId !== participant.id);
        unread = fresh.length;
        mentions = fresh.filter((m) => m.mentions.includes(participant.id)).length;
      }
      let title = c.name;
      let others: Array<{ id: string; displayName: string; kind: string }> = [];
      if (c.kind === "dm" || c.kind === "group") {
        const ms = await ctx.db.find(channelMembers, { channelId: c.id });
        for (const m of ms) {
          if (m.participantId === participant.id) continue;
          const p = await ctx.db.get(participants, m.participantId);
          if (p) others.push({ id: p.id, displayName: p.displayName, kind: p.kind });
        }
        title = others.map((o) => o.displayName).join(", ") || `${participant.displayName} (you)`;
      }
      out.push({ id: c.id, kind: c.kind, name: c.name, title, topic: c.topic ?? null, isMember: Boolean(member), unread: Math.min(unread, UNREAD_CAP), unreadCapped: unread > UNREAD_CAP, mentions, others, isDefault: Boolean(c.isDefault) });
    }
    out.sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
    return out;
  },
});

/** Channel header and member list. */
export const get = app.query({
  access: "channels.read",
  args: { channelId: s.string() },
  handler: async (ctx, { channelId }) => {
    const { channel, member, role } = await loadChannel(ctx, channelId);
    const members = [];
    for (const m of await ctx.db.find(channelMembers, { channelId })) {
      const p = await ctx.db.get(participants, m.participantId);
      if (p) members.push({ participantId: p.id, handle: p.handle, displayName: p.displayName, kind: p.kind, title: p.title ?? null });
    }
    return {
      id: channel.id, workspaceId: channel.workspaceId, kind: channel.kind, name: channel.name, topic: channel.topic ?? null, isDefault: Boolean(channel.isDefault),
      isMember: Boolean(member), lastReadSeq: member?.lastReadSeq ?? 0, members,
      canManage: atLeast(role, "admin") || channel.createdBy === member?.participantId,
    };
  },
});

export const create = app.mutation({
  access: "channels.create",
  args: { workspaceId: s.optional(s.string()), name: s.string({ minLength: 1, maxLength: 80 }), kind: s.enum(["public", "private"]), topic: s.optional(s.string({ maxLength: 250 })) },
  returns: s.string(),
  capability: { name: "channels.create", description: "Create a public or private channel in the session's workspace." },
  handler: async (ctx, { name, kind, topic }) => {
    const { participant, workspaceId } = await loadWorkspace(ctx);
    const clean = channelName(name);
    if (!clean) fail("INVALID_ARGUMENT", "Channel names use letters, numbers and dashes.");
    const taken = (await ctx.db.find(channels, { name: clean })).some((c) => c.kind === "public" || c.kind === "private");
    if (taken) fail("FAILED_PRECONDITION", `#${clean} already exists.`);
    const id = await ctx.db.insert(channels, { workspaceId, kind, name: clean, ...(topic?.trim() ? { topic: topic.trim() } : {}), createdBy: participant.id, createdAt: Date.now() });
    await joinChannel(ctx, workspaceId, id, participant.id);
    await record(ctx, workspaceId, participant.id, "channel.created", `${participant.displayName} created ${kind} channel #${clean}`, id);
    return id;
  },
});

export const setTopic = app.mutation({
  access: "channels.manage",
  args: { channelId: s.string(), topic: s.string({ maxLength: 250 }) },
  handler: async (ctx, { channelId, topic }) => {
    const { channel } = await loadChannel(ctx, channelId);
    if (channel.kind === "dm") fail("FAILED_PRECONDITION", "Direct messages have no topic.");
    await ctx.db.patch(channels, channelId, { topic: topic.trim() || undefined });
  },
});

/** Join a public channel. Private channels are joined by being added. */
export const join = app.mutation({
  access: "channels.join",
  args: { channelId: s.string() },
  handler: async (ctx, { channelId }) => {
    const { channel, participant } = await loadChannel(ctx, channelId);
    if (channel.kind !== "public") fail("FORBIDDEN", "Only public channels can be joined.");
    await joinChannel(ctx, channel.workspaceId, channelId, participant.id);
  },
});

export const leave = app.mutation({
  access: "channels.leave",
  args: { channelId: s.string() },
  handler: async (ctx, { channelId }) => {
    const { channel, member, participant } = await loadChannel(ctx, channelId);
    if (!member) return;
    if (channel.isDefault) fail("FAILED_PRECONDITION", `Everyone stays in #${channel.name}.`);
    if (channel.kind === "dm") fail("FAILED_PRECONDITION", "You cannot leave a direct message.");
    await ctx.db.delete(channelMembers, member.id);
    await record(ctx, channel.workspaceId, participant.id, "channel.left", `${participant.displayName} left #${channel.name}`, channelId);
  },
});

/** Add workspace members to a channel the caller is in (private channels and groups included). */
export const addMembers = app.mutation({
  access: "channels.manage",
  args: { channelId: s.string(), participantIds: s.array(s.string(), { minItems: 1, maxItems: 50 }) },
  handler: async (ctx, { channelId, participantIds }) => {
    const { channel, participant } = await loadChannel(ctx, channelId);
    if (channel.kind === "dm") fail("FAILED_PRECONDITION", "Start a group conversation to add people.");
    const names = [];
    for (const pid of participantIds) {
      const p = await ctx.db.get(participants, pid);
      if (!p || !(await inWorkspace(ctx, p))) fail("NOT_FOUND", "Someone you added is not in this workspace.");
      await joinChannel(ctx, channel.workspaceId, channelId, pid);
      names.push((await ctx.db.get(participants, pid))?.displayName ?? pid);
    }
    await record(ctx, channel.workspaceId, participant.id, "channel.members.added", `${participant.displayName} added ${names.join(", ")} to ${channel.kind === "group" ? "a group" : "#" + channel.name}`, channelId);
  },
});

/** Open (or find) the direct message or group conversation with exactly these people. */
export const openConversation = app.mutation({
  access: "channels.converse",
  args: { workspaceId: s.optional(s.string()), participantIds: s.array(s.string(), { minItems: 1, maxItems: 8 }) },
  returns: s.string(),
  capability: { name: "conversations.open", description: "Open a direct message or group conversation with workspace members." },
  handler: async (ctx, { participantIds }) => {
    const { participant, workspaceId } = await loadWorkspace(ctx);
    const ids = [...new Set([participant.id, ...participantIds])].sort();
    for (const pid of ids) {
      const p = await ctx.db.get(participants, pid);
      if (!p || !(await inWorkspace(ctx, p))) fail("NOT_FOUND", "Someone in that conversation is not in this workspace.");
    }
    const dmKey = ids.join(",");
    const [existing] = await ctx.db.find(channels, { dmKey });
    if (existing) return existing.id;
    const kind = ids.length <= 2 ? "dm" : "group";
    const id = await ctx.db.insert(channels, { workspaceId, kind, name: kind, dmKey, createdBy: participant.id, createdAt: Date.now() });
    for (const pid of ids) await joinChannel(ctx, workspaceId, id, pid);
    return id;
  },
});

/** Mark a conversation read up to `seq`. Only moves forward. */
export const markRead = app.mutation({
  access: "channels.markRead",
  args: { channelId: s.string(), seq: s.number() },
  handler: async (ctx, { channelId, seq }) => {
    const { member } = await loadChannel(ctx, channelId);
    if (member && seq > member.lastReadSeq) await ctx.db.patch(channelMembers, member.id, { lastReadSeq: seq });
  },
});
