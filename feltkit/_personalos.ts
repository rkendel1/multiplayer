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
 *   - its own identity to PersonalOS: a bridge session (PERSONALOS_BRIDGE_TOKEN) that holds only
 *     `interactions.receive` there.
 * It never resolves who the sender is in PersonalOS (Resolver does, in PersonalOS) and never decides
 * what they may do (AuthBoundry does, in PersonalOS). Display names travel as presentation only.
 */
import { fail } from "@feltdb/feltkit";
import { channelMembers, messages, participants } from "./app.js";
import { PERSONALOS } from "./_ops.js";

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

  // Bounded context, oldest first, ending at the request: the thread, or the latest top-level messages.
  let scope: "thread" | "channel" = "channel";
  let picked: any[];
  let truncated = false;
  if (source.rootId) {
    scope = "thread";
    const root = await ctx.db.get(messages, source.rootId);
    const replies = (await ctx.db.find(messages, { rootId: source.rootId })).filter((m: any) => m.seq <= source.seq).sort((a: any, b: any) => a.seq - b.seq);
    truncated = replies.length + 1 > LIMITS.thread;
    picked = [root, ...replies.slice(-(LIMITS.thread - 1))].filter(Boolean);
  } else {
    const limit = directWithAssistant ? LIMITS.dm : LIMITS.channel;
    const page = await ctx.db.query(messages, { where: [{ field: "channelId", eq: channel.id }, { field: "topLevel", eq: true }, { field: "seq", lte: source.seq }], orderBy: [{ field: "seq", direction: "desc" }], limit: limit + 1 });
    truncated = page.records.length > limit;
    picked = page.records.slice(0, limit).reverse();
  }
  const people = new Map<string, any>();
  const who = async (id: string) => { if (!people.has(id)) people.set(id, await ctx.db.get(participants, id)); return people.get(id); };
  const ref = (m: any) => (m.attachments ?? []).slice(0, LIMITS.attachments).map((a: any) => ({ id: a.id, name: String(a.name).slice(0, 300), contentType: a.contentType, size: a.size, messageId: m.id }));
  const context = [];
  for (const m of picked.filter((x: any) => !x.deletedAt)) {
    const a = await who(m.authorId);
    const text = String(m.text);
    if (text.length > LIMITS.chars) truncated = true;
    context.push({
      id: m.id,
      ...(a?.principalId && !a.persona ? { authorSourcePrincipalId: a.principalId } : {}),
      authorName: String(a?.displayName ?? "Former member").slice(0, 120),
      authorKind: a?.kind === "agent" ? "agent" as const : "human" as const,
      isRequester: m.authorId === requester.id,
      text: text.slice(0, LIMITS.chars),
      at: m.createdAt,
      ...(m.rootId ? { threadId: m.rootId } : {}),
      attachments: ref(m),
    });
  }
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

/** A PersonalOS function over its HTTP API, as the bridge session. Failures keep their code, so the agent retries what can change. */
export async function call(kind: "query" | "mutation", name: string, args: Record<string, unknown>): Promise<any> {
  const url = process.env.PERSONALOS_URL;
  const token = process.env.PERSONALOS_BRIDGE_TOKEN;
  if (!url || !token) fail("UNAVAILABLE", "PersonalOS is not connected (PERSONALOS_URL, PERSONALOS_BRIDGE_TOKEN).");
  let response: Response;
  try {
    response = await fetch(new URL(`/api/${kind}/${encodeURIComponent(name)}`, url), {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ args }),
    });
  } catch (error) {
    fail("UNAVAILABLE", `PersonalOS is unreachable: ${(error as Error).message}`);
  }
  let payload: any;
  try { payload = await response.json(); } catch { fail("UNAVAILABLE", `PersonalOS answered ${response.status} without JSON.`); }
  if (payload?.ok) return payload.value;
  const e = payload?.error ?? {};
  const err = new Error(e.message ?? `PersonalOS refused (${response.status})`) as Error & { code: string; remote: true };
  err.code = e.code ?? "UNAVAILABLE";
  err.remote = true;
  throw err;
}
