/**
 * Multiplayer's conversation policy, in one place: `authorize` is registered with
 * `feltkit({ authorize })` (feltkit/app.ts). FeltKit calls it for every call to every function —
 * HTTP, AppPort, MCP, agent actions and jobs — after the role check and argument validation, before
 * the handler, with the validated arguments and the call's own read-only, tenant-scoped db.
 *
 * Which workspace, and the caller's role there, come from FeltKit (`principal.tenant`): the session's
 * workspace, resolved from the live membership on every request. Nothing in the arguments can choose
 * another one: a `workspaceId` argument (kept for compatibility) that differs from the session's is
 * refused, and ids from another workspace do not resolve (workspace data collections are
 * tenant-scoped). Unknown ids and ids the caller may not see are refused alike (NOT_FOUND), so a
 * refusal reveals nothing. A function this policy does not recognise is refused (default deny).
 *
 * Who may call which function is decided by the roles (feltkit/app.ts), least privilege per role.
 * What stays here is application semantics: private channels, direct messages and groups, guests and agents seeing only conversations they were
 * brought into, and the agent queue belonging to its agent. Handlers do not repeat these checks: they
 * use the loaders below (loadWorkspace, loadChannel).
 */
import { fail, type AuthContext, type AuthorizeHook, type AuthorizeRequest, type DatabaseReader, type Doc } from "@feltdb/feltkit";
import { agentRequests, attachments, channelMembers, channels, messages, participants, sharedObjects, type WorkspaceRole } from "./app.js";

/** Stored records, typed by their collection's declared shape (plus id and version). */
export type ParticipantDoc = Doc<typeof participants.shape>;
export type ChannelDoc = Doc<typeof channels.shape>;
export type ChannelMemberDoc = Doc<typeof channelMembers.shape>;

/**
 * What the loaders need from a call's context: FeltKit's own auth context and read-only, tenant-scoped
 * database. Every QueryCtx and MutationCtx satisfies it; nothing wider is accepted.
 */
export interface Ctx {
  readonly auth: AuthContext;
  readonly db: DatabaseReader;
}

const RANK: Record<WorkspaceRole, number> = { guest: 1, agent: 1, member: 2, admin: 3, owner: 4 };

/** Whether a workspace role ranks at least `min` (for what the UI offers; permissions decide access). */
export function atLeast(role: string, min: WorkspaceRole): boolean {
  return (RANK[role as WorkspaceRole] ?? 0) >= RANK[min];
}

// ── The policy ──────────────────────────────────────────────────────────────

/** Functions that need no workspace: the caller's own profile and inbox. */
const UNSCOPED = new Set(["me:get", "me:ensure", "me:updateProfile", "inbox:list", "inbox:markRead"]);
/** Mutations on a conversation that a caller who has not joined it may make. */
const NON_MEMBER_WRITES = new Set(["channels:join", "channels:markRead", "channels:leave", "messages:remove"]);
/** The room agent's run (app.agent, as the agent's principal): only the agent a request was made to works it. */
const AGENT_WORK = new Set(["agent/assistant"]);

const hidden = (): never => fail("NOT_FOUND", "Not found.");

type Target = { channelId?: string; agentId?: string };

/**
 * The conversation a call is about, from the arguments that name one. Reads go through the
 * tenant-scoped db, so a record of another workspace is simply absent (null → NOT_FOUND).
 */
async function target(r: AuthorizeRequest): Promise<Target | null> {
  const { args, db } = r;
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  // An event subscription (kind "observe") names its conversation as its scope.
  const channelArg = str("channelId") ?? (r.kind === "observe" ? str("scope") : undefined);
  if (channelArg) { const c = await db.get(channels, channelArg); return c ? { channelId: c.id } : null; }
  for (const k of ["rootId", "messageId"]) {
    if (str(k)) { const m = await db.get(messages, str(k)!); return m ? { channelId: m.channelId } : null; }
  }
  if (str("attachmentId")) { const a = await db.get(attachments, str("attachmentId")!); return a ? { channelId: a.channelId } : null; }
  if (str("requestId")) { const q = await db.get(agentRequests, str("requestId")!); return q ? { channelId: q.channelId, agentId: q.agentId } : null; }
  if (r.function === "agents:plan" && str("id")) { const o = await db.get(sharedObjects, str("id")!); return o ? { channelId: o.channelId } : null; }
  return {}; // the workspace itself
}

export const authorize: AuthorizeHook = async (r) => {
  if (UNSCOPED.has(r.function)) return true;
  if (!r.principal) return { allowed: false, code: "UNAUTHORIZED" };
  // The session's workspace, from FeltKit's live membership. None: not a member (or no longer).
  const tenant = r.principal.tenant ?? hidden();
  // A workspaceId argument is never trusted: it must be the session's own workspace.
  if (r.args.workspaceId !== undefined && r.args.workspaceId !== tenant.id) hidden();
  const role = tenant.role;
  const [me] = await r.db.find(participants, { principalId: r.principal.id });
  if (!me) fail("FAILED_PRECONDITION", "No profile yet: call me:ensure first.");
  const t = (await target(r)) ?? hidden();
  if (AGENT_WORK.has(r.function) && t.agentId !== me.id) hidden();
  if (!t.channelId) return true;
  const channel = await r.db.get(channels, t.channelId);
  if (!channel || channel.workspaceId !== tenant.id) return hidden();
  const [member] = await r.db.find(channelMembers, { channelId: channel.id, participantId: me.id });
  // Public channels are readable by members of the workspace except guests and agents, who see only
  // conversations they were added to. Private channels, DMs and groups: their members only.
  if (!member && !(channel.kind === "public" && openToRole(role))) hidden();
  if (r.kind === "mutation" && !member && !NON_MEMBER_WRITES.has(r.function)) {
    return { allowed: false, code: "FORBIDDEN", reason: "Join the channel to post in it." };
  }
  return true;
};

const openToRole = (role: string) => role !== "guest" && role !== "agent";

// ── Loaders (no policy: `authorize` has already decided) ─────────────────────

/** Thrown when a loader finds what the policy should have refused: a policy bug, refused closed. */
const policyGap = (what: string): never => fail("INTERNAL", `authorize admitted a call without ${what}.`);

/** The caller's participant record. */
export async function me(ctx: Ctx): Promise<ParticipantDoc> {
  const principal = ctx.auth.requirePrincipal();
  const [p] = await ctx.db.find(participants, { principalId: principal.id });
  return p ?? fail("FAILED_PRECONDITION", "No profile yet: call me:ensure first.");
}

/** The caller's participant, the session's workspace and the caller's role there (FeltKit's). */
export async function loadWorkspace(ctx: Ctx) {
  const tenant = ctx.auth.tenant ?? policyGap("a workspace");
  return { participant: await me(ctx), workspaceId: tenant.id, workspaceName: tenant.name, role: tenant.role };
}

/** A conversation, with the caller's participant, workspace role and channel membership (null if not joined). */
export async function loadChannel(ctx: Ctx, channelId: string): Promise<{ channel: ChannelDoc; participant: ParticipantDoc; role: string; member: ChannelMemberDoc | null }> {
  const channel = (await ctx.db.get(channels, channelId)) ?? hidden();
  const { participant, role } = await loadWorkspace(ctx);
  const [member] = await ctx.db.find(channelMembers, { channelId, participantId: participant.id });
  return { channel, participant, role, member: member ?? null };
}

/** The conversations the caller can read in the session's workspace (filters lists and search; not a gate). */
export async function readableChannels(ctx: Ctx, participantId: string, role: string): Promise<ChannelDoc[]> {
  const all = await ctx.db.find(channels, {});
  const mine = new Set((await ctx.db.find(channelMembers, { participantId })).map((m) => m.channelId));
  return all.filter((c) => mine.has(c.id) || (c.kind === "public" && openToRole(role)));
}
