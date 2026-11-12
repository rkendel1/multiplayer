/**
 * The conversation context an agent reads for a request: one selector for every reader (the room
 * agent, feltkit/agents.ts; PersonalOS's envelope, feltkit/_personalos.ts), so the rules that make
 * context safe are written once:
 *
 *   visibility   read through the calling agent's own `ctx.db`, under Multiplayer's channel policy
 *                (an agent reads only conversations it was brought into)
 *   bounds       the request's thread, or the latest top-level messages up to the request; each
 *                reader states its own limits, and the result says when it was cut
 *   provenance   every message keeps its id, author, time, thread and attachment references
 *   people       the requester is distinguished from other participants; agents from people;
 *                sample personas carry no principal
 *
 * Readers differ in what they make of it (a project plan; an interaction envelope), not in how it is chosen.
 */
import { messages, participants } from "./app.js";

export interface ContextMessage {
  id: string;
  authorId: string;
  authorName: string;
  handle: string;
  authorKind: "human" | "agent";
  /** The author's principal, when the author is an account (not a sample persona, not a former member). */
  authorPrincipalId?: string;
  isRequester: boolean;
  text: string;
  at: number;
  threadId?: string;
  attachments: Array<{ id: string; name: string; contentType?: string; size?: number; messageId: string }>;
}

export interface ContextLimits {
  /** Messages of a thread, the root included. */
  thread: number;
  /** Top-level messages of a channel. */
  channel: number;
  /** Characters per message (longer text is cut and the result says so). */
  chars: number;
  attachments: number;
  /** Thread replies after the request are included (the room agent's historical behavior) or not. */
  repliesAfterRequest: boolean;
}

type Db = { db: { get(c: any, id: string): Promise<any>; find(c: any, f?: any): Promise<any[]>; query(c: any, q: any): Promise<{ records: any[] }> } };

export async function selectContext(ctx: Db, source: { id: string; channelId: string; rootId?: string; seq: number }, requesterId: string, limits: ContextLimits): Promise<{ scope: "thread" | "channel"; messages: ContextMessage[]; truncated: boolean }> {
  let scope: "thread" | "channel" = "channel";
  let picked: any[];
  let truncated = false;
  if (source.rootId) {
    scope = "thread";
    const root = await ctx.db.get(messages, source.rootId);
    const replies = (await ctx.db.find(messages, { rootId: source.rootId }))
      .filter((m: any) => limits.repliesAfterRequest || m.seq <= source.seq)
      .sort((a: any, b: any) => a.seq - b.seq);
    truncated = replies.length + 1 > limits.thread;
    picked = [root, ...replies.slice(-(Math.max(0, limits.thread - 1)))].filter(Boolean);
  } else {
    const page = await ctx.db.query(messages, { where: [{ field: "channelId", eq: source.channelId }, { field: "topLevel", eq: true }, { field: "seq", lte: source.seq }], orderBy: [{ field: "seq", direction: "desc" }], limit: limits.channel + 1 });
    truncated = page.records.length > limits.channel;
    picked = page.records.slice(0, limits.channel).reverse();
  }
  const people = new Map<string, any>();
  const who = async (id: string) => { if (!people.has(id)) people.set(id, await ctx.db.get(participants, id)); return people.get(id); };
  const out: ContextMessage[] = [];
  for (const m of picked.filter((x: any) => !x.deletedAt).sort((a: any, b: any) => a.seq - b.seq)) {
    const a = await who(m.authorId);
    const text = String(m.text);
    if (text.length > limits.chars) truncated = true;
    out.push({
      id: m.id,
      authorId: m.authorId,
      authorName: a?.displayName ?? "Unknown",
      handle: a?.handle ?? "unknown",
      authorKind: a?.kind === "agent" ? "agent" : "human",
      ...(a?.principalId && !a.persona ? { authorPrincipalId: a.principalId } : {}),
      isRequester: m.authorId === requesterId,
      text: text.slice(0, limits.chars),
      at: m.createdAt,
      ...(m.rootId ? { threadId: m.rootId } : {}),
      attachments: (m.attachments ?? []).slice(0, limits.attachments).map((x: any) => ({ id: x.id, name: String(x.name).slice(0, 300), contentType: x.contentType, size: x.size, messageId: m.id })),
    });
  }
  return { scope, messages: out, truncated };
}
