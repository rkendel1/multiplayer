/**
 * PersonalOS in Multiplayer: one participant, @personalos, that relays a person's request to *their own*
 * PersonalOS account and posts the answer where they asked. It is the room-agent pattern (app.agent):
 * messages:send records the request (an agentRequest) and triggers this agent in the same transaction;
 * FeltKit runs it after the commit as PersonalOS's own principal here, under the same roles, tenancy and
 * channel policy as any call.
 *
 * It is a relay, not a second assistant. Understanding, identity resolution (Resolver), authority
 * (AuthBoundry), execution, memory, tasks, approvals and the audit trail are PersonalOS's. This file
 * only: re-verifies the request when it runs, builds the envelope (feltkit/_personalos.ts), delivers it
 * with the request's idempotency key, and posts what PersonalOS says, in the originating thread.
 *
 *   deliver   the first run after the mention (or a DM to PersonalOS)
 *   sync      later updates (an approval decided in PersonalOS): fetched when someone looking at the
 *             conversation asks (personalos:sync). FeltKit cannot deliver events into an app from
 *             outside it, so this surface pulls (docs/ANYWHERE.md, platform gaps)
 *   cancel    the requester withdraws a pending request (personalos:cancel)
 *
 * Delivery is at least once, its writes at most once (FeltKit's outbox); PersonalOS executes once per
 * idempotency key, so a retried delivery returns the same outcome and nothing runs twice.
 */
import { fail, s } from "@feltdb/feltkit";
import { activity, agentRequests, app, channelMembers, messages, participants } from "./app.js";
import { loadChannel, loadWorkspace, me } from "./_authz.js";
import { ensurePersonalOS, inWorkspace, insertMessage, PERSONALOS } from "./_ops.js";
import { call, envelope, instance, terminal } from "./_personalos.js";
import { record } from "./_util.js";

/** Errors that a later attempt can change (the other side was down, or slow). Everything else is final. */
const RETRYABLE = new Set(["UNAVAILABLE", "INTERNAL", "OUTCOME_UNKNOWN", "DEADLINE_EXCEEDED", "CONFLICT"]);
const ATTEMPTS = 4;

type Op = "deliver" | "sync" | "cancel";

export const personalos = app.agent("personalos", {
  principal: { id: PERSONALOS, displayName: "PersonalOS" },
  roles: ["personalos"],
  access: "personalos.work",
  retry: { maxAttempts: ATTEMPTS, backoffMs: 500 },
  handler: async (ctx, input: { requestId: string; op?: Op }) => {
    const op: Op = input.op ?? "deliver";
    const agent = await me(ctx);
    const req = await ctx.db.get(agentRequests, input.requestId);
    if (!req || req.agentId !== agent.id) return;
    if (op === "deliver" && req.phase !== "received") return; // delivered already (a repeated run)
    if (op !== "deliver" && (!req.interactionKey || terminal(req.phase))) return;
    const { channel } = await loadChannel(ctx, req.channelId);
    const ws = await loadWorkspace(ctx);
    const source = await ctx.db.get(messages, req.messageId);
    const requester = await ctx.db.get(participants, req.requestedBy);
    const reply = async (text: string) => {
      // In a DM with PersonalOS, answer in the conversation; elsewhere, in the request's thread.
      const members = await ctx.db.find(channelMembers, { channelId: channel.id });
      const direct = channel.kind === "dm" && members.length === 2;
      const root = direct || !source ? null : await ctx.db.get(messages, source.rootId ?? source.id);
      const posted = await insertMessage(ctx, channel, agent.id, { text: text.slice(0, 8000), root, mentions: requester && !direct ? [requester.id] : [] });
      ctx.afterCommit.webhooks.emit("message.posted", {
        workspaceId: channel.workspaceId, channelId: channel.id, channelKind: channel.kind, messageId: posted.id, seq: posted.seq, authorId: agent.id,
        ...(root ? { threadId: root.id } : {}), ...(channel.kind === "public" ? { text } : {}), at: posted.now,
      });
      if (requester?.kind === "human" && !requester.persona) {
        ctx.afterCommit.notifications.send({ recipient: requester.principalId, type: "agent.replied", title: "@personalos answered you", body: text.slice(0, 200), data: { workspaceId: channel.workspaceId, channelId: channel.id, messageId: posted.id }, idempotencyKey: `personalos:${req.id}:${posted.seq}` });
      }
      return posted.id;
    };
    const finish = (fields: Record<string, unknown>) => ctx.db.patch(agentRequests, req.id, { ...fields, finishedAt: Date.now() });

    // Authority is checked when the work runs, not when it was asked: the requester must still be in
    // the workspace and in the conversation, and the request must still be theirs and undeleted.
    if (!requester || !(await inWorkspace(ctx, requester)) || !(await ctx.db.find(channelMembers, { channelId: channel.id, participantId: requester.id })).length || !source || source.deletedAt || source.authorId !== requester.id) {
      if (op === "deliver") {
        const id = await reply("I didn't act on this: the person who asked no longer has access to this conversation, or the request was removed. Nothing was sent to PersonalOS.");
        await finish({ status: "failed", phase: "refused", replyId: id, error: "requester no longer has access" });
      }
      return;
    }

    const attempt = ctx.trigger.attempt;
    const failed = async (error: any) => {
      const code = String(error?.code ?? "INTERNAL");
      if (RETRYABLE.has(code) && attempt < ATTEMPTS) throw error; // FeltKit retries with backoff; nothing here committed
      if (op === "sync") return; // the next sync tries again
      const text = op === "deliver"
        ? code === "UNAVAILABLE" || code === "OUTCOME_UNKNOWN"
          ? `I couldn't reach PersonalOS after ${attempt} tries, so I can't confirm your request was received. Check PersonalOS before asking again.`
          : `PersonalOS refused this request (${code}): ${String(error?.message ?? "").slice(0, 300)}`
        : `I couldn't cancel it in PersonalOS (${code}). Check PersonalOS.`;
      const id = await reply(text);
      if (op === "deliver") await finish({ status: "failed", phase: "failed", replyId: id, error: `${code}: ${String(error?.message ?? "").slice(0, 400)}` });
    };

    if (op === "deliver") {
      let outcome: any;
      try {
        outcome = await call("mutation", "interactions:receive", { envelope: await envelope(ctx, req, channel, { id: ws.workspaceId, name: ws.workspaceName }) });
      } catch (error) { return failed(error); }
      const id = await reply(outcome.reply || "Done.");
      await ctx.db.patch(agentRequests, req.id, {
        phase: outcome.state, interactionKey: `${instance()}:${req.messageId}`, deliveredSeq: outcome.updateSeq, replyId: id,
        status: terminal(outcome.state) ? (outcome.state === "completed" ? "done" : "failed") : "pending",
        ...(terminal(outcome.state) ? { finishedAt: Date.now() } : {}),
      });
      await record(ctx, channel.workspaceId, agent.id, "personalos.replied", `@personalos ${outcome.state.replace(/_/g, " ")} for ${requester.displayName}`, id);
      return;
    }

    let st: { state: string; updates: Array<{ seq: number; text: string; state: string }>; revoked: boolean };
    try {
      st = op === "sync"
        ? await call("query", "interactions:status", { key: req.interactionKey, afterSeq: req.deliveredSeq ?? 0 })
        : await call("mutation", "interactions:cancel", { key: req.interactionKey, sourcePrincipalId: requester.principalId });
    } catch (error) { return failed(error); }
    if (st.revoked) {
      await reply(`PersonalOS is no longer connected for ${requester.displayName}, so I won't post more about this request here.`);
      return finish({ status: "failed", phase: "cancelled", error: "link revoked" });
    }
    let seq = req.deliveredSeq ?? 0;
    let last: string | undefined;
    for (const u of st.updates.filter((x) => x.seq > seq).sort((a, b) => a.seq - b.seq)) {
      last = await reply(u.text);
      seq = u.seq;
    }
    await ctx.db.patch(agentRequests, req.id, {
      phase: st.state, deliveredSeq: seq, ...(last ? { replyId: last } : {}),
      ...(terminal(st.state) ? { status: st.state === "completed" ? "done" : "failed", finishedAt: Date.now() } : {}),
    });
  },
});

/**
 * After an admin added PersonalOS to the workspace through FeltKit (client.addMember("personalos",
 * "agent")): its profile, so @personalos resolves, and the record of it.
 */
export const add = app.mutation({
  access: "agents.manage",
  args: { workspaceId: s.optional(s.string()) },
  returns: s.string(),
  handler: async (ctx) => {
    const { participant, workspaceId } = await loadWorkspace(ctx);
    const id = await ensurePersonalOS(ctx);
    if (!(await ctx.db.find(activity, { type: "personalos.added", subjectId: id })).length) {
      await record(ctx, workspaceId, participant.id, "personalos.added", `${participant.displayName} added @${PERSONALOS} to the workspace`, id);
    }
    return id;
  },
});

/** Ask PersonalOS for news on a pending request (an approval decided there). Anyone who can read the conversation; at most every 3 s. */
export const sync = app.mutation({
  access: "messages.read",
  args: { requestId: s.string() },
  returns: s.boolean(),
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(agentRequests, requestId);
    if (!req) fail("NOT_FOUND", "Not found.");
    await loadChannel(ctx, req.channelId);
    const agent = (await ctx.db.find(participants, { principalId: PERSONALOS }))[0];
    if (!agent || req.agentId !== agent.id || !req.interactionKey || terminal(req.phase)) return false;
    if (req.lastSyncAt && Date.now() - req.lastSyncAt < 3000) return false;
    await ctx.db.patch(agentRequests, requestId, { lastSyncAt: Date.now() });
    ctx.afterCommit.agent("personalos", { requestId, op: "sync" });
    return true;
  },
});

/** The requester withdraws a request PersonalOS has not finished. */
export const cancel = app.mutation({
  access: "messages.write",
  args: { requestId: s.string() },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(agentRequests, requestId);
    if (!req) fail("NOT_FOUND", "Not found.");
    const { participant } = await loadChannel(ctx, req.channelId);
    if (req.requestedBy !== participant.id) fail("FORBIDDEN", "Only the person who asked can cancel it.");
    if (!req.interactionKey || terminal(req.phase)) fail("FAILED_PRECONDITION", "There is nothing pending to cancel.");
    ctx.afterCommit.agent("personalos", { requestId, op: "cancel" });
  },
});
