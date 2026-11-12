/**
 * Multiplayer as a PersonalOS Anywhere surface: how a request made here becomes PersonalOS's canonical
 * interaction envelope (`personalos.interaction/1`, defined and documented by PersonalOS in
 * feltkit/_interaction.ts and docs/INTERACTION-CONTRACT.md), and how it is delivered.
 *
 * What this adapter vouches for, and nothing more:
 *   - the sender: the participant FeltKit authenticated when the message was posted (messages:send
 *     records it as `requestedBy` from the verified session), as its principal id here;
 *   - the conversation and the context: messages the requester can read, read by PersonalOS's own
 *     principal under Multiplayer's channel policy, bounded below;
 *   - its own identity to PersonalOS: a bridge session that holds only `interactions.receive` there,
 *     held as the credential reference of the declared `personalos` integration (feltkit/app.ts).
 * It never resolves who the sender is in PersonalOS (Resolver does, in PersonalOS) and never decides
 * what they may do (AuthBoundry does, in PersonalOS). Display names travel as presentation only.
 */
import { fail } from "@feltdb/feltkit";
import { channelMembers, messages, participants } from "./app.js";
import { PERSONALOS } from "./_ops.js";
import { selectContext } from "./_context.js";

export const CONTRACT = "personalos.interaction/1";
/** The adapter id: must equal the bridge session's principal id in PersonalOS. */
export const ADAPTER = "multiplayer";
/** How much conversation PersonalOS is given: a thread up to the request, else recent top-level messages. */
export const LIMITS = { thread: 40, channel: 25, dm: 15, chars: 1000, attachments: 10 } as const;

/** Which Multiplayer installation this is (part of every external identity and idempotency key). */
export function instance(): string {
  return process.env.MULTIPLAYER_INSTANCE ?? process.env.FELTKIT_PUBLIC_URL ?? "multiplayer-development";
}

const states = new Set(["completed", "failed", "cancelled", "refused"]);
export const terminal = (phase: string | undefined) => !!phase && states.has(phase);

type Ctx = { db: { get(c: any, id: string): Promise<any>; find(c: any, f?: any, o?: any): Promise<any[]>; query(c: any, q: any): Promise<{ records: any[]; exhausted?: boolean }> } };

/** The envelope for one request, built from what the PersonalOS agent may read here. */
export async function envelope(ctx: Ctx, req: any, channel: any, workspace: { id: string; name: string }) {
  const source = await ctx.db.get(messages, req.messageId);
  if (!source || source.deletedAt) fail("NOT_FOUND", "The request was deleted.");
  if (source.authorId !== req.requestedBy) fail("FORBIDDEN", "The request's author is not who it was recorded for.");
  const requester = await ctx.db.get(participants, req.requestedBy);
  if (!requester?.principalId || requester.persona || requester.kind !== "human") fail("FORBIDDEN", "Only a person with an account can ask PersonalOS.");
  const members = await ctx.db.find(channelMembers, { channelId: channel.id });
  const memberIds = new Set(members.map((m: any) => m.participantId));
  const assistant = (await ctx.db.find(participants, { principalId: PERSONALOS }))[0];
  const directWithAssistant = channel.kind === "dm" && memberIds.size === 2 && memberIds.has(requester.id) && !!assistant && memberIds.has(assistant.id);

  // Bounded context, oldest first, ending at the request (feltkit/_context.ts, shared with the room agent).
  const selected = await selectContext(ctx, source, requester.id, { thread: LIMITS.thread, channel: directWithAssistant ? LIMITS.dm : LIMITS.channel, chars: LIMITS.chars, attachments: LIMITS.attachments, repliesAfterRequest: false });
  const scope = selected.scope;
  const truncated = selected.truncated;
  const context = selected.messages.map((m) => ({
    id: m.id,
    ...(m.authorPrincipalId ? { authorSourcePrincipalId: m.authorPrincipalId } : {}),
    authorName: String(m.authorName).slice(0, 120),
    authorKind: m.authorKind,
    isRequester: m.isRequester,
    text: m.text,
    at: m.at,
    ...(m.threadId ? { threadId: m.threadId } : {}),
    attachments: m.attachments,
  }));
  const people = new Map<string, any>();
  const who = async (id: string) => { if (!people.has(id)) people.set(id, await ctx.db.get(participants, id)); return people.get(id); };
  const ref = (m: any) => (m.attachments ?? []).slice(0, LIMITS.attachments).map((a: any) => ({ id: a.id, name: String(a.name).slice(0, 300), contentType: a.contentType, size: a.size, messageId: m.id }));
  const handles = [];
  for (const id of source.mentions ?? []) { const p = await who(id); if (p) handles.push(String(p.handle)); }
  // A public channel is readable by the whole workspace, not only by its members.
  const participantCount = channel.kind === "public" ? Math.max(memberIds.size, 3) : memberIds.size;
  const key = `${instance()}:${source.id}`;
  return {
    contract: CONTRACT,
    source: { adapter: ADAPTER, instance: instance(), eventId: source.id, sequence: source.seq, receivedAt: source.createdAt },
    sender: {
      sourcePrincipalId: requester.principalId,
      displayName: String(requester.displayName).slice(0, 120),
      handle: requester.handle,
      ...(req.timeZone ? { timeZone: req.timeZone } : {}),
    },
    conversation: {
      workspaceId: workspace.id, workspaceName: String(workspace.name).slice(0, 120),
      conversationId: channel.id, kind: channel.kind, ...(channel.kind === "public" || channel.kind === "private" ? { name: channel.name } : {}),
      ...(source.rootId ? { threadId: source.rootId, parentMessageId: source.rootId } : {}),
      participantCount, directWithAssistant,
    },
    message: { id: source.id, text: String(source.text).slice(0, 4000) || "(no text)", mentions: { assistant: !!assistant && (source.mentions ?? []).includes(assistant.id), handles: handles.slice(0, 50) }, attachments: ref(source) },
    context: { scope, messages: context, limits: { maxMessages: source.rootId ? LIMITS.thread : directWithAssistant ? LIMITS.dm : LIMITS.channel, maxChars: LIMITS.chars, truncated } },
    respondTo: { conversationId: channel.id, ...(source.rootId || !directWithAssistant ? { threadId: source.rootId ?? source.id } : {}) },
    idempotencyKey: key,
  };
}

/**
 * A PersonalOS interaction function, through the declared `personalos` integration (feltkit/app.ts):
 * FeltKit resolves the bridge session's credential reference for the request and records the call;
 * this code never holds the token. A refusal by PersonalOS (4xx) keeps a code the agent can act on;
 * no answer (5xx, timeout) is UNAVAILABLE / OUTCOME_UNKNOWN, which the agent retries, safely, since
 * PersonalOS executes once per envelope idempotency key.
 */
export async function call(ctx: { integrations: { invoke(capability: string, input: Record<string, unknown>): Promise<unknown> } }, op: "receive" | "status" | "cancel", args: Record<string, unknown>): Promise<any> {
  let out: { ok?: boolean; value?: unknown };
  try {
    out = (await ctx.integrations.invoke(`personalos.${op}`, { args })) as { ok?: boolean; value?: unknown };
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: { status?: number } };
    if (e.code !== "UPSTREAM_REJECTED") throw error;
    const status = e.details?.status;
    const code = status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "FAILED_PRECONDITION" : "UPSTREAM_REJECTED";
    throw Object.assign(new Error(String(e.message ?? `PersonalOS refused (${status})`)), { code, remote: true });
  }
  if (!out?.ok) fail("UNAVAILABLE", "PersonalOS answered without a result.");
  return out.value;
}
