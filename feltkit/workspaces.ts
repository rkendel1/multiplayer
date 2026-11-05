import { s } from "@feltdb/feltkit";
import { app, presence } from "./app.js";
import { loadWorkspace } from "./_authz.js";
import { directory } from "./_ops.js";

/**
 * The session's workspace (FeltKit's: name, and the caller's role there) and its directory (FeltKit's
 * current members with a profile, and sample personas), with presence. Live: re-runs when a membership changes. Creating, renaming, members, roles and invitations are FeltKit's (`/api/tenants/…`).
 */
export const get = app.query({
  access: "workspaces.read",
  args: { workspaceId: s.optional(s.string()) },
  handler: async (ctx) => {
    const { workspaceId, workspaceName, role } = await loadWorkspace(ctx);
    const pres = new Map((await ctx.db.find(presence, {})).map((p) => [p.participantId, p]));
    const members = [];
    for (const p of await directory(ctx)) {
      const pr = pres.get(p.id);
      members.push({
        participantId: p.id, handle: p.handle, displayName: p.displayName, title: p.title ?? null, kind: p.kind, agentType: p.agentType ?? null, persona: Boolean(p.persona),
        lastSeenAt: pr?.lastSeenAt ?? null, status: pr?.status ?? null,
      });
    }
    members.sort((a, b) => (a.displayName.toLowerCase() < b.displayName.toLowerCase() ? -1 : 1));
    return { id: workspaceId, name: workspaceName, myRole: role, members, now: Date.now() };
  },
});
