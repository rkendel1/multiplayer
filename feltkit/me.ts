import { s } from "@feltdb/feltkit";
import { app, participants } from "./app.js";
import { me as requireMe } from "./_authz.js";
import { enterWorkspace, ensureDefaultChannels } from "./_ops.js";
import { baseHandle, record } from "./_util.js";

const Participant = s.doc(participants);

/** The caller's profile, or null before the first me:ensure. Workspaces are FeltKit's (GET /api/tenants). */
export const get = app.query({
  access: "authenticated",
  handler: async (ctx) => {
    const principal = ctx.auth.requirePrincipal();
    const [p] = await ctx.db.find(participants, { principalId: principal.id });
    return p ? { participant: p } : null;
  },
});

/**
 * Create the caller's participant on first use and, in a session working in a workspace, enter it:
 * the workspace's default channels exist, and on first entry the caller joins them (unless a guest
 * or an agent) and the join is recorded. Idempotent; clients call it after every switch.
 */
export const ensure = app.mutation({
  access: "authenticated",
  args: { displayName: s.optional(s.string({ minLength: 1, maxLength: 80 })) },
  returns: Participant,
  handler: async (ctx, { displayName }) => {
    const principal = ctx.auth.requirePrincipal();
    let [p] = await ctx.db.find(participants, { principalId: principal.id });
    if (!p) {
      const name = displayName?.trim() || principal.displayName || principal.id;
      const handle = await freeHandle(ctx, baseHandle(principal.type === "user" && principal.id.includes("@") ? principal.id : name));
      const id = await ctx.db.insert(participants, {
        principalId: principal.id,
        kind: principal.type === "agent" ? "agent" : "human",
        ...(principal.type === "agent" ? { agentType: "application" as const } : {}),
        handle,
        displayName: name,
        createdAt: Date.now(),
      });
      p = (await ctx.db.get(participants, id))!;
    }
    const tenant = app.tenant(ctx);
    if (tenant) {
      if (tenant.role !== "agent" && tenant.role !== "guest" && (await ensureDefaultChannels(ctx, tenant.id, p.id))) {
        await record(ctx, tenant.id, p.id, "workspace.created", `${p.displayName} set up ${tenant.name}`, tenant.id);
      }
      await enterWorkspace(ctx, tenant.id, p, tenant.role);
    }
    return p;
  },
});

export const updateProfile = app.mutation({
  access: "authenticated",
  args: { displayName: s.string({ minLength: 1, maxLength: 80 }), title: s.optional(s.string({ maxLength: 80 })) },
  handler: async (ctx, { displayName, title }) => {
    const p = await requireMe(ctx);
    await ctx.db.patch(participants, p.id, { displayName: displayName.trim(), title: title?.trim() || undefined });
  },
});

export async function freeHandle(ctx: { db: { find(c: any, f: any): Promise<any[]> } }, base: string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const h = n === 0 ? base : `${base.slice(0, 28)}${n + 1}`;
    if (!(await ctx.db.find(participants, { handle: h })).length) return h;
  }
  return `${base.slice(0, 20)}-${Date.now() % 100000}`;
}
