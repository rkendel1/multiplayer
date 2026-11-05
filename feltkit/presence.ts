import { s } from "@feltdb/feltkit";
import { app, presence, typing } from "./app.js";
import { loadChannel, loadWorkspace } from "./_authz.js";

/**
 * Presence: who is around is durable enough to show to someone who opens the workspace
 * later, so it stays one bounded record per participant per workspace, overwritten in place. Clients
 * treat lastSeenAt older than 60 s as offline.
 */
export const heartbeat = app.mutation({
  access: "presence.write",
  args: { workspaceId: s.optional(s.string()), status: s.enum(["active", "away"]) },
  handler: async (ctx, { status }) => {
    const { participant, workspaceId } = await loadWorkspace(ctx);
    const fields = { lastSeenAt: Date.now(), status };
    const [existing] = await ctx.db.find(presence, { participantId: participant.id });
    if (existing) await ctx.db.patch(presence, existing.id, fields);
    else await ctx.db.insert(presence, { workspaceId, participantId: participant.id, ...fields });
  },
});

/** Typing: an ephemeral event to the conversation's readers (app.event + useEvent), nothing stored. */
export const typingIn = app.mutation({
  access: "messages.write",
  args: { channelId: s.string(), typing: s.boolean() },
  handler: async (ctx, { channelId, typing: on }) => {
    const { participant } = await loadChannel(ctx, channelId);
    ctx.events.publish(typing, { participantId: participant.id, name: participant.displayName, typing: on }, { scope: channelId });
  },
});
