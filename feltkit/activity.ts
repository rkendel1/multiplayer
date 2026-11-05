import { s } from "@feltdb/feltkit";
import { activity, app, participants } from "./app.js";
import { loadWorkspace } from "./_authz.js";

/** The workspace's audit trail of meaningful changes, newest first. Members only. */
export const list = app.query({
  access: "activity.read",
  args: { workspaceId: s.optional(s.string()) },
  handler: async (ctx) => {
    await loadWorkspace(ctx);
    const page = await ctx.db.query(activity, { where: [], orderBy: [{ field: "at", direction: "desc" }], limit: 100 });
    const names = new Map<string, string>();
    const out = [];
    for (const a of page.records) {
      if (!names.has(a.actorId)) names.set(a.actorId, (await ctx.db.get(participants, a.actorId))?.displayName ?? a.actorId);
      out.push({ id: a.id, type: a.type, summary: a.summary, actor: names.get(a.actorId)!, at: a.at, subjectId: a.subjectId ?? null });
    }
    return out;
  },
});
