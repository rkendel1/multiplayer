import { fail, s } from "@feltdb/feltkit";
import { activity, agentRequests, app, messages, participants, sharedObjects } from "./app.js";
import { me, readableChannels, loadChannel, loadWorkspace } from "./_authz.js";
import { composeDeterministic, type Composer, type Context } from "./_compose.js";
import { ensureRoomAgent, insertMessage, ROOM_AGENT } from "./_ops.js";
import { record } from "./_util.js";

/**
 * The room agent, a FeltKit application agent (`app.agent`). A person @mentions it:
 * messages:send records an agentRequest (what was asked, by whom; the UI shows its state) and
 * triggers the agent with `ctx.afterCommit.agent`, in the same transaction. FeltKit runs the handler
 * after the commit as the agent's own principal ("assistant", type agent, role "agent"), through the
 * same roles, tenant scoping and `authorize` as any call (function "agent/assistant"; the policy lets
 * it work only its own requests in conversations it was brought into). It works in the caller's
 * workspace only while it is a FeltKit member there itself. Delivery is at least once, its writes at
 * most once (FeltKit's outbox, lease, retries and transaction ids); the handler is also idempotent
 * on the request's status. Not available in AppBoundry artifacts (FeltKit refuses app.agent there).
 */
const compose: Composer = composeDeterministic;

export const assistant = app.agent("assistant", {
  principal: { id: ROOM_AGENT, displayName: "Assistant" },
  roles: ["agent"],
  access: "agents.work",
  // Overlapping replies in one conversation contend on its message sequence; app.agent cannot opt into
  // in-place re-execution (mutations can: retry.sequenceConflicts), so the loser is retried soon.
  retry: { maxAttempts: 6, backoffMs: 250 },
  handler: async (ctx, input: { requestId: string }) => {
    const agent = await me(ctx);
    const req = await ctx.db.get(agentRequests, input.requestId);
    if (!req || req.status !== "pending") return; // answered already (a repeated delivery)
    const { channel } = await loadChannel(ctx, req.channelId);
    const context = await conversation(ctx, req, channel);
    let reply;
    try {
      reply = await compose(context);
    } catch (error: any) {
      await ctx.db.patch(agentRequests, req.id, { status: "failed", finishedAt: Date.now(), error: String(error?.message ?? error).slice(0, 500) });
      return;
    }
    const plan = reply.plan;
    if (plan) ctx.auth.require("plans.write");
    const now = Date.now();
    const sharedObjectId = plan
      ? await ctx.db.insert(sharedObjects, { workspaceId: channel.workspaceId, channelId: channel.id, kind: "project_plan", ...plan, createdBy: agent.id, requestedBy: req.requestedBy, createdAt: now })
      : undefined;
    const source = (await ctx.db.get(messages, req.messageId))!;
    const root = (await ctx.db.get(messages, source.rootId ?? source.id))!;
    const requester = await ctx.db.get(participants, req.requestedBy);
    const { id } = await insertMessage(ctx, channel, agent.id, { text: reply.text, root, mentions: requester ? [requester.id] : [], ...(sharedObjectId ? { sharedObjectId } : {}) });
    await ctx.db.patch(agentRequests, req.id, { status: "done", finishedAt: now, replyId: id, ...(sharedObjectId ? { sharedObjectId } : {}) });
    await record(ctx, channel.workspaceId, agent.id, plan ? "agent.plan.created" : "agent.replied", plan ? `@${agent.handle} created plan "${plan.title}"` : `@${agent.handle} replied`, sharedObjectId ?? id);
    if (requester && requester.kind === "human" && !requester.persona) {
      ctx.afterCommit.notifications.send({ recipient: requester.principalId, type: "agent.replied", title: `@${agent.handle} answered you`, body: reply.text.slice(0, 200), data: { workspaceId: channel.workspaceId, channelId: channel.id, messageId: id }, idempotencyKey: `agent:${req.id}` });
    }
  },
});

/** What the agent reads to answer: the thread the request was made in, or the channel's recent top-level messages, up to the request. */
async function conversation(ctx: any, req: any, channel: any): Promise<Context> {
  const source = (await ctx.db.get(messages, req.messageId))!;
  const scope = source.rootId
    ? [(await ctx.db.get(messages, source.rootId))!, ...(await ctx.db.find(messages, { rootId: source.rootId }))]
    : (await ctx.db.query(messages, { where: [{ field: "channelId", eq: req.channelId }, { field: "topLevel", eq: true }, { field: "seq", lte: source.seq }], orderBy: [{ field: "seq", direction: "desc" }], limit: 150 })).records;
  const names = new Map<string, any>();
  const out = [];
  for (const m of scope.filter((m: any) => !m.deletedAt).sort((a: any, b: any) => a.seq - b.seq)) {
    if (!names.has(m.authorId)) names.set(m.authorId, await ctx.db.get(participants, m.authorId));
    const a = names.get(m.authorId);
    out.push({ id: m.id, author: a?.displayName ?? "Unknown", handle: a?.handle ?? "unknown", authorKind: a?.kind ?? "human", text: m.text, createdAt: m.createdAt });
  }
  const requester = await ctx.db.get(participants, req.requestedBy);
  return { request: { id: req.id, prompt: req.prompt, requestedBy: requester?.displayName ?? "someone", requestedByHandle: requester?.handle ?? null }, channel: { id: channel.id, name: channel.name, kind: channel.kind, topic: channel.topic ?? null }, messages: out };
}

/**
 * After an admin added the room agent to the workspace through FeltKit (client.addMember("assistant",
 * "agent")): make sure it has a profile (so @assistant resolves) and record it. Mentions reach it only
 * while it is a FeltKit member.
 */
export const add = app.mutation({
  access: "workspaces.write",
  args: { workspaceId: s.optional(s.string()) },
  returns: s.string(),
  handler: async (ctx) => {
    const { participant, workspaceId } = await loadWorkspace(ctx);
    const agentId = await ensureRoomAgent(ctx);
    if (!(await ctx.db.find(activity, { type: "agent.added", subjectId: agentId })).length) {
      await record(ctx, workspaceId, participant.id, "agent.added", `${participant.displayName} added @${ROOM_AGENT} to the workspace`, agentId);
    }
    return agentId;
  },
});

/** Requests in a conversation and their state (the UI shows "working on it…"). */
export const requests = app.query({
  access: "messages.read",
  args: { channelId: s.string() },
  handler: async (ctx, { channelId }) => {
    await loadChannel(ctx, channelId);
    return (await ctx.db.find(agentRequests, { channelId })).map((r) => ({ id: r.id, messageId: r.messageId, status: r.status, error: r.error ?? null, replyId: r.replyId ?? null }));
  },
});

export const plan = app.query({
  access: "plans.read",
  args: { id: s.string() },
  returns: s.doc(sharedObjects).extend({ createdByName: s.string() }),
  capability: { name: "plans.get", description: "Read a project plan from a conversation the caller can read." },
  handler: async (ctx, { id }) => {
    const o = await ctx.db.get(sharedObjects, id);
    if (!o) fail("NOT_FOUND", "Plan not found.");
    await loadChannel(ctx, o.channelId);
    const author = await ctx.db.get(participants, o.createdBy);
    return { ...o, createdByName: author?.displayName ?? "Unknown" };
  },
});

/** Plans in the conversations the caller can read. */
export const plans = app.query({
  access: "plans.read",
  args: { workspaceId: s.optional(s.string()) },
  handler: async (ctx) => {
    const { participant, role } = await loadWorkspace(ctx);
    const readable = new Set((await readableChannels(ctx, participant.id, role)).map((c) => c.id));
    return (await ctx.db.find(sharedObjects, {}, { orderBy: [{ field: "createdAt", direction: "desc" }] }))
      .filter((o) => readable.has(o.channelId))
      .map((o) => ({ id: o.id, channelId: o.channelId, title: o.title, tasks: o.tasks.length, createdAt: o.createdAt }));
  },
});
