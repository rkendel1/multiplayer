/**
 * The room agent's reasoning, as a pure function: conversation in, reply (and optional plan) out.
 *
 * Deterministic by default: it extracts decisions, action items with owners and dates, risks and
 * open questions from what people actually wrote, and cites the messages it used. Nothing is
 * invented. A model can be put behind the same Composer interface later;
 * the application does not depend on one.
 */
export interface ContextMessage { id: string; author: string; handle: string; authorKind: string; text: string; createdAt: number }
export interface Context {
  request: { id: string; prompt: string; requestedBy: string; requestedByHandle: string | null };
  channel: { id: string; name: string; kind: string; topic: string | null };
  messages: ContextMessage[];
}
export interface PlanItem { title: string; owner?: string; due?: string; sourceMessageId?: string }
export interface Plan { title: string; summary: string; goals: string[]; tasks: PlanItem[]; decisions: string[]; risks: string[]; openQuestions: string[]; sourceMessageIds: string[] }
export interface Reply { text: string; plan?: Plan }
export type Composer = (context: Context) => Promise<Reply> | Reply;

const DATE = /\b(by|before|on|until|the week of|due)\s+((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2}|tomorrow|next week|end of (?:day|week|month))/i;
const ACTION = /\b(i'll|i will|we need to|need to|needs to|can you|could you|will|todo|to do|own|owns|let's)\b/i;
const DECISION = /\b(decided|decision|agreed|we(?:'ll| will) go with|we go with|going with)\b/i;
const RISK = /\b(risk|blocker|blocked|concern|worried|flaky|slip|delay)\b/i;
const GOAL = /\b(goal|objective|aim|target)\b/i;

function sentence(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^(decided|risk|goal|open question)\s*:\s*/i, "").trim().replace(/[.!]+$/, "");
}

function ownerFor(m: ContextMessage, all: ContextMessage[]): string | undefined {
  const t = m.text;
  if (/\b(i'll|i will|i can)\b/i.test(t)) return m.author;
  const mention = /@([a-z0-9-]+)/i.exec(t)?.[1];
  if (mention) return all.find((x) => x.handle === mention.toLowerCase())?.author ?? `@${mention}`;
  // "Jonas, can you …" → the named person, if they took part.
  const named = /^([A-Z][a-z]+),\s+(can|could|would) you/.exec(t)?.[1];
  if (named) return all.find((x) => x.author.split(" ")[0] === named)?.author ?? named;
  return undefined;
}

export function wantsPlan(prompt: string): boolean {
  return /\b(plan|project plan|action items|tasks|roadmap|next steps)\b/i.test(prompt);
}

export const composeDeterministic: Composer = (ctx) => {
  const msgs = ctx.messages.filter((m) => m.authorKind !== "agent" && m.id !== undefined);
  const discussion = msgs.filter((m) => !/@assistant\b/i.test(m.text));
  const people = [...new Set(discussion.map((m) => m.author))];
  const used = new Set<string>();
  const pick = (re: RegExp) => discussion.filter((m) => re.test(m.text)).map((m) => (used.add(m.id), m));

  const goals = pick(GOAL).map((m) => sentence(m.text));
  const decisions = pick(DECISION).map((m) => sentence(m.text));
  const risks = pick(RISK).map((m) => sentence(m.text));
  const openQuestions = discussion.filter((m) => /\?\s*$/.test(m.text.trim()) && !/\b(can|could) you\b/i.test(m.text)).map((m) => (used.add(m.id), sentence(m.text.replace(/^open question:\s*/i, ""))));
  const tasks: PlanItem[] = [];
  for (const m of discussion) {
    if (!ACTION.test(m.text) || DECISION.test(m.text) || /\?\s*$/.test(m.text.trim()) && !/\b(can|could) you\b/i.test(m.text)) continue;
    // A "Yes, I'll …" answer confirms an earlier request: keep the more specific one.
    const due = DATE.exec(m.text);
    const item: PlanItem = { title: sentence(m.text).replace(/^(yes|great|ok|okay|sure)[,.!]?\s*/i, ""), sourceMessageId: m.id };
    const owner = ownerFor(m, discussion);
    if (owner) item.owner = owner;
    if (due) item.due = `${due[1]} ${due[2]}`.replace(/^the week of/i, "week of");
    tasks.push(item);
    used.add(m.id);
  }
  const topic = ctx.channel.kind === "public" || ctx.channel.kind === "private" ? `#${ctx.channel.name}` : "this conversation";
  const summary = discussion.length
    ? `${people.length} ${people.length === 1 ? "person" : "people"} (${people.join(", ")}) discussed ${ctx.channel.topic ? `“${ctx.channel.topic}”` : topic} across ${discussion.length} messages. ` +
      `${decisions.length} decision${decisions.length === 1 ? "" : "s"}, ${tasks.length} action item${tasks.length === 1 ? "" : "s"}, ${risks.length} risk${risks.length === 1 ? "" : "s"} and ${openQuestions.length} open question${openQuestions.length === 1 ? "" : "s"}.`
    : "There is nothing in this conversation to summarize yet.";

  const lines = [`**Summary of ${topic}** — ${summary}`];
  if (decisions.length) lines.push("", "**Decisions**", ...decisions.map((d) => `• ${d}`));
  if (risks.length) lines.push("", "**Risks**", ...risks.map((r) => `• ${r}`));
  if (openQuestions.length) lines.push("", "**Open questions**", ...openQuestions.map((q) => `• ${q}?`));

  if (!wantsPlan(ctx.request.prompt) || !discussion.length) return { text: lines.join("\n") };
  const plan: Plan = {
    title: `Project plan: ${ctx.channel.topic ?? topic}`.slice(0, 160),
    summary, goals, tasks, decisions, risks, openQuestions,
    sourceMessageIds: [...used],
  };
  lines.push("", `I turned it into a project plan with ${tasks.length} task${tasks.length === 1 ? "" : "s"}${tasks.filter((t) => t.owner).length ? ` (${tasks.filter((t) => t.owner).length} with owners)` : ""}. It's attached below.`);
  return { text: lines.join("\n"), plan };
};
