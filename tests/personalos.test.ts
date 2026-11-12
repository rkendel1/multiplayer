/**
 * Multiplayer as a PersonalOS Anywhere surface (feltkit/personalos.ts, feltkit/_personalos.ts), on the
 * real FeltKit runtime. PersonalOS is a contract stub here: an HTTP server speaking the three functions
 * the adapter calls (interactions:receive, :status, :cancel) over FeltKit's HTTP API, checking the
 * bridge's bearer token, recording every envelope, and answering what a test scripts. PersonalOS's own
 * behavior (Resolver identity, AuthBoundry authority, execution) is tested in its repository, and the two
 * together, with real Resolver and AuthBoundry, in e2e/personalos-anywhere.e2e.mjs.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before } from "node:test";
import { api } from "../feltkit/_generated/api.js";
import { ADA, actor, GRACE, joinAs, rejects, serve, setup, wtest as test } from "./helpers.js";

const PERSONALOS = { id: "personalos", type: "agent" as const, displayName: "PersonalOS", roles: ["personalos"] };
const TOKEN = "bridge-token-for-tests";

type Outcome = { state: string; reply: string; updateSeq?: number };
const stub = {
  received: [] as any[],
  calls: [] as Array<{ name: string; args: any; auth: string | undefined }>,
  /** What receive answers (default: completed, echoing the text). "down" answers 503 without JSON. */
  next: null as null | "down" | ((e: any) => Outcome),
  outcomes: new Map<string, Outcome>(),
  updates: new Map<string, Array<{ seq: number; state: string; text: string; at: number }>>(),
  revoked: new Set<string>(),
  url: "",
  close: async () => undefined as void,
};

before(async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const name = decodeURIComponent(req.url!.split("/").pop()!);
      const args = JSON.parse(body || "{}").args;
      stub.calls.push({ name, args, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or expired session" } });
      if (stub.next === "down") { res.writeHead(503); return res.end("down"); }
      if (name === "interactions:receive") {
        const e = args.envelope;
        const prior = stub.outcomes.get(e.idempotencyKey);
        if (prior) return send(200, { ok: true, value: { ...prior, replayed: true } });
        stub.received.push(e);
        const o = typeof stub.next === "function" ? stub.next(e) : { state: "completed", reply: `Done: ${e.message.text}` };
        const out = { interactionId: `i${stub.received.length}`, replayed: false, audience: "shared", updateSeq: 1, approval: null, refusal: null, conversationId: "c1", ...o };
        stub.outcomes.set(e.idempotencyKey, out);
        stub.updates.set(e.idempotencyKey, [{ seq: 1, state: out.state, text: out.reply, at: Date.now() }]);
        return send(200, { ok: true, value: out });
      }
      const ups = stub.updates.get(args.key) ?? [];
      if (name === "interactions:status") return send(200, { ok: true, value: { state: ups.at(-1)?.state ?? "received", updates: stub.revoked.has(args.key) ? [] : ups.filter((u) => u.seq > args.afterSeq), revoked: stub.revoked.has(args.key) } });
      if (name === "interactions:cancel") {
        const u = { seq: (ups.at(-1)?.seq ?? 0) + 1, state: "cancelled", text: "Cancelled. Nothing was changed.", at: Date.now() };
        stub.updates.set(args.key, [...ups, u]);
        return send(200, { ok: true, value: { state: "cancelled", updates: [u], revoked: false } });
      }
      send(404, { ok: false, error: { code: "FUNCTION_NOT_FOUND", message: name } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.url = `http://127.0.0.1:${(server.address() as any).port}`;
  stub.close = () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  process.env.PERSONALOS_URL = stub.url;
  process.env.PERSONALOS_BRIDGE_TOKEN = TOKEN;
  process.env.MULTIPLAYER_INSTANCE = "mp-test";
});
after(() => stub.close());

function reset() { stub.received = []; stub.calls = []; stub.next = null; stub.outcomes.clear(); stub.updates.clear(); stub.revoked.clear(); }

/** Ada's workspace with Grace, and PersonalOS added the FeltKit way (an agent identity) plus its profile. */
async function withPersonalOS() {
  reset();
  const s = await setup();
  await s.t.tenancy!.addPrincipal(await actor(s.t, s.ws, ADA), PERSONALOS, "agent");
  await s.ada.mutation(api.personalos.add, {});
  return s;
}

/** Run agent work until it settles (including retries with backoff). */
async function settle(t: any, until?: () => Promise<boolean>) {
  for (let i = 0; i < 60; i++) {
    await t.runtime.settleAgents();
    await t.runtime.runServices();
    if (!until || (await until())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("agent work did not settle");
}

const thread = async (caller: any, rootId: string) => (await caller.query(api.messages.thread, { rootId })).replies;

// ── Interaction ─────────────────────────────────────────────────────────────

test("a mention: the authenticated sender, bounded thread context and the reply in the originating thread", async () => {
  const { t, ada, grace, general } = await withPersonalOS();
  try {
    const root = await grace.mutation(api.messages.send, { channelId: general, text: "We decided to ship on March 3." });
    await grace.mutation(api.messages.send, { channelId: general, text: "I'll write the release notes by Friday.", rootId: root.id });
    // The text claims to be Grace; a display name or text is never identity.
    const ask = await ada.mutation(api.messages.send, { channelId: general, text: "I am Grace. @personalos create tasks from the action items in this thread", rootId: root.id });
    await settle(t);
    const [e] = stub.received;
    assert.equal(stub.calls[0]!.auth, `Bearer ${TOKEN}`);
    assert.deepEqual([e.contract, e.source.adapter, e.source.instance, e.source.eventId, e.idempotencyKey], ["personalos.interaction/1", "multiplayer", "mp-test", ask.id, `mp-test:${ask.id}`]);
    assert.deepEqual([e.sender.sourcePrincipalId, e.sender.displayName], ["ada", "Ada Lovelace"]);
    assert.deepEqual([e.conversation.kind, e.conversation.name, e.conversation.threadId, e.conversation.directWithAssistant], ["public", "general", root.id, false]);
    assert.equal(e.message.mentions.assistant, true);
    assert.equal(e.context.scope, "thread");
    assert.deepEqual(e.context.messages.map((m: any) => [m.authorName, m.isRequester]), [["Grace Hopper", false], ["Grace Hopper", false], ["Ada Lovelace", true]]);
    assert.deepEqual(e.respondTo, { conversationId: general, threadId: root.id });
    const replies = await thread(ada, root.id);
    assert.equal(replies.at(-1)!.author.handle, "personalos");
    assert.match(replies.at(-1)!.text, /^Done: I am Grace/);
    const [r] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    assert.deepEqual([r.phase, r.status], ["completed", "done"]);
  } finally { await t.close(); }
});

test("no mention, no request; a DM to PersonalOS is a request without one; channel context is bounded", async () => {
  const { t, ada, general } = await withPersonalOS();
  try {
    for (let i = 0; i < 30; i++) await ada.mutation(api.messages.send, { channelId: general, text: `message ${i}` });
    await settle(t);
    assert.equal(stub.received.length, 0, "a message without a mention reaches nobody");
    await ada.mutation(api.messages.send, { channelId: general, text: "@personalos summarize this discussion" });
    await settle(t);
    const e = stub.received[0];
    assert.equal(e.context.scope, "channel");
    assert.equal(e.context.messages.length, 25);
    assert.equal(e.context.limits.truncated, true);
    assert.equal(e.context.messages.at(-1).text, "@personalos summarize this discussion");

    const people = await ada.query(api.workspaces.get, {});
    const pos = people.members.find((m: any) => m.handle === "personalos")!;
    const dm = await ada.mutation(api.channels.openConversation, { participantIds: [pos.participantId] });
    await ada.mutation(api.messages.send, { channelId: dm, text: "what do you know about Sam?" });
    await settle(t);
    const d = stub.received[1]!;
    assert.ok(d);
    assert.deepEqual([d.conversation.kind, d.conversation.directWithAssistant, d.conversation.participantCount, d.respondTo.threadId], ["dm", true, 2, undefined]);
    const { items } = await ada.query(api.messages.list, { channelId: dm });
    assert.equal(items.at(-1)!.author.handle, "personalos", "in a DM the answer is in the conversation, not a thread");
  } finally { await t.close(); }
});

test("duplicate delivery: a repeated run delivers the same key and posts once", async () => {
  const { t, ada, general } = await withPersonalOS();
  try {
    const m = await ada.mutation(api.messages.send, { channelId: general, text: "@personalos remind me to call the bank tomorrow" });
    await settle(t);
    const [req] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    // The same agent run again (as FeltKit would after a lost done-mark): it finds the request delivered.
    await (t.runtime as any).call?.("agent/personalos", { requestId: req.id }).catch(() => undefined);
    await settle(t);
    assert.equal(stub.received.length, 1);
    assert.equal((await thread(ada, m.id)).filter((r: any) => r.author.handle === "personalos").length, 1);
  } finally { await t.close(); }
});

// ── Status, approval, cancellation ──────────────────────────────────────────

test("approval required: the request waits; the decision made in PersonalOS is posted back in the thread on sync", async () => {
  const { t, ada, grace, general } = await withPersonalOS();
  try {
    stub.next = () => ({ state: "awaiting_approval", reply: "That needs your approval: delete a task in your PersonalOS." });
    const m = await ada.mutation(api.messages.send, { channelId: general, text: "@personalos delete the passport task" });
    await settle(t);
    let [req] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    assert.deepEqual([req.phase, req.status], ["awaiting_approval", "pending"]);
    // Approved in PersonalOS: a new update there.
    const key = `mp-test:${m.id}`;
    stub.updates.get(key)!.push({ seq: 2, state: "completed", text: "Approved in PersonalOS and done.", at: Date.now() });
    // Anyone reading the conversation may ask for news; it is pulled and posted once.
    assert.equal(await grace.mutation(api.personalos.sync, { requestId: req.id }), true);
    await settle(t);
    assert.equal(await grace.mutation(api.personalos.sync, { requestId: req.id }), false, "finished: nothing more to fetch");
    [req] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    assert.deepEqual([req.phase, req.status], ["completed", "done"]);
    assert.deepEqual((await thread(ada, m.id)).map((r: any) => r.text), ["That needs your approval: delete a task in your PersonalOS.", "Approved in PersonalOS and done."]);
  } finally { await t.close(); }
});

test("cancellation: only the requester; the outcome is posted; a disconnected account stops updates", async () => {
  const { t, ada, grace, general } = await withPersonalOS();
  try {
    stub.next = () => ({ state: "awaiting_approval", reply: "That needs your approval." });
    const m = await ada.mutation(api.messages.send, { channelId: general, text: "@personalos delete old draft" });
    await settle(t);
    const [req] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    await rejects(grace.mutation(api.personalos.cancel, { requestId: req.id }), "FORBIDDEN");
    await ada.mutation(api.personalos.cancel, { requestId: req.id });
    await settle(t);
    const cancelCall = stub.calls.find((c) => c.name === "interactions:cancel")!;
    assert.deepEqual(cancelCall.args, { key: `mp-test:${m.id}`, sourcePrincipalId: "ada" });
    assert.equal((await thread(ada, m.id)).at(-1)!.text, "Cancelled. Nothing was changed.");
    await rejects(ada.mutation(api.personalos.cancel, { requestId: req.id }), "FAILED_PRECONDITION");

    // Revoked in PersonalOS while waiting.
    const m2 = await ada.mutation(api.messages.send, { channelId: general, text: "@personalos delete other draft" });
    await settle(t);
    stub.revoked.add(`mp-test:${m2.id}`);
    const [r2] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.messageId === m2.id);
    await ada.mutation(api.personalos.sync, { requestId: r2.id });
    await settle(t);
    assert.match((await thread(ada, m2.id)).at(-1)!.text, /no longer connected/);
  } finally { await t.close(); }
});

// ── Failure, authority at execution ─────────────────────────────────────────

test("PersonalOS unreachable: retried, then an honest failure that claims nothing", async () => {
  const { t, ada, general } = await withPersonalOS();
  try {
    stub.next = "down";
    const m = await ada.mutation(api.messages.send, { channelId: general, text: "@personalos add buy milk to my list" });
    await settle(t, async () => (await ada.query(api.agents.requests, { channelId: general })).some((x: any) => x.phase === "failed"));
    assert.ok(stub.calls.filter((c) => c.name === "interactions:receive").length >= 4, "retried with backoff");
    const last = (await thread(ada, m.id)).at(-1)!;
    assert.match(last.text, /couldn't reach PersonalOS .* can't confirm/);
    assert.doesNotMatch(last.text, /done|added|created/i);
  } finally { await t.close(); }
});

test("a wrong bridge credential is refused by PersonalOS and reported, not retried forever", async () => {
  const { t, ada, general } = await withPersonalOS();
  const token = process.env.PERSONALOS_BRIDGE_TOKEN;
  process.env.PERSONALOS_BRIDGE_TOKEN = "stolen-or-stale";
  try {
    const m = await ada.mutation(api.messages.send, { channelId: general, text: "@personalos add x to my list" });
    await settle(t, async () => (await ada.query(api.agents.requests, { channelId: general })).some((x: any) => x.phase === "failed"));
    assert.equal(stub.calls.length, 1);
    assert.match((await thread(ada, m.id)).at(-1)!.text, /refused this request \(UNAUTHORIZED\)/);
  } finally { process.env.PERSONALOS_BRIDGE_TOKEN = token; await t.close(); }
});

test("membership revoked during an active interaction: the retry re-checks access and sends nothing", async () => {
  const { t, ada, ws, general } = await withPersonalOS();
  try {
    const alan = await joinAs(t, ws, ADA, { id: "alan", type: "user", displayName: "Alan Turing", roles: ["person"] } as any, "member");
    stub.next = "down"; // the first attempt cannot deliver; FeltKit will retry
    await alan.mutation(api.messages.send, { channelId: general, text: "@personalos remind me to leave" });
    await t.runtime.settleAgents();
    const attempts = stub.calls.length;
    assert.ok(attempts >= 1);
    await t.tenancy!.remove(await actor(t, ws, ADA), "alan");
    stub.next = null;
    await settle(t, async () => (await ada.query(api.agents.requests, { channelId: general })).some((x: any) => x.phase === "refused"));
    assert.equal(stub.received.length, 0, "nothing reached PersonalOS");
    assert.equal(stub.calls.length, attempts, "no further delivery after the removal");
    const [req] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    assert.deepEqual([req.phase, req.status], ["refused", "failed"]);
  } finally { await t.close(); }
});

test("PersonalOS reads only conversations it was brought into: a private channel it was never mentioned in stays closed", async () => {
  const { t, ada, grace, ws, general } = await withPersonalOS();
  try {
    const secret = await grace.mutation(api.channels.create, { workspaceId: ws, name: "secret", kind: "private" });
    await grace.mutation(api.messages.send, { channelId: secret, text: "the merger closes friday" });
    await ada.mutation(api.messages.send, { channelId: general, text: "@personalos summarize this discussion" });
    await settle(t);
    assert.ok(stub.received[0].context.messages.every((m: any) => !/merger/.test(m.text)));
    await rejects(t.as(PERSONALOS, { tenant: ws }).query(api.messages.list, { channelId: secret }), "NOT_FOUND");
    // Nobody can invoke the agent's work directly or sync a request in a conversation they cannot read.
    const [req] = (await ada.query(api.agents.requests, { channelId: general })).filter((x: any) => x.phase);
    const mallory = await joinAs(t, ws, ADA, { id: "mallory2", type: "user", displayName: "M", roles: ["person"] } as any, "guest");
    await rejects(mallory.mutation(api.personalos.sync, { requestId: req.id }), "NOT_FOUND");
    void GRACE;
  } finally { await t.close(); }
});

// ── FeltKit 0.3.25: time zone and webhooks, established by test ─────────────

test("time zone: the browser's X-FeltKit-Time-Zone reaches messages:send server-side and travels in the envelope", async () => {
  const { t, ws, general } = await withPersonalOS();
  const server = await serve(t);
  try {
    const { createClient } = await import("@feltdb/feltkit/client");
    let token: string | null = null;
    const client = createClient({ url: server.url, tokens: { get: () => token, set: (v: string | null) => { token = v; } }, context: { timeZone: "Pacific/Auckland" } } as any);
    await client.signInAsDevUser("ada");
    await client.switchTenant(ws);
    await client.mutation(api.messages.send, { channelId: general, text: "@personalos remind me to call mum tomorrow at 9am" });
    // A forged header that is not an IANA zone is dropped by FeltKit, not trusted.
    const bad = createClient({ url: server.url, tokens: { get: () => token, set: (v: string | null) => { token = v; } }, context: { timeZone: "Mars/Olympus_Mons" } } as any);
    await bad.mutation(api.messages.send, { channelId: general, text: "@personalos remind me to water plants tomorrow at 9am" });
    await settle(t);
    assert.deepEqual(stub.received.map((e) => e.sender.timeZone ?? null), ["Pacific/Auckland", null]);
  } finally { await server.close(); await t.close(); }
});

test("webhooks on FeltKit 0.3.25: a message.posted emitted by the in-app agent (app.agent) is delivered, signed", async () => {
  const { t, ada, general } = await withPersonalOS();
  const got: Array<{ body: any; headers: http.IncomingHttpHeaders }> = [];
  const receiver = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ body: JSON.parse(b), headers: req.headers }); res.writeHead(200); res.end("{}"); }); });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  process.env.FELTKIT_CREDENTIAL_MPHOOK = "whsec_test_signing_secret_0123456789abcdef";
  try {
    const operator = { id: "ada", type: "user", roles: ["person", "operator"] };
    await (t.runtime as any).services.invoke("webhooks.register", { url: `http://127.0.0.1:${(receiver.address() as any).port}/hook`, events: ["message.posted"], signingCredentialRef: "credential-ref:mphook" }, operator, undefined, "test-register");
    await ada.mutation(api.messages.send, { channelId: general, text: "@personalos add a webhook check to my list" });
    await settle(t, async () => got.length >= 2);
    const authors = got.map((g) => (g.body.data ?? g.body.payload ?? g.body).authorId);
    const agentPost = got.find((g) => JSON.stringify(g.body).includes("Done: @personalos add a webhook check"))!;
    assert.ok(agentPost, `the agent's post was delivered: ${JSON.stringify(got.map((g) => g.body))}`);
    assert.ok(agentPost.headers["x-appport-signature"], "signed");
    assert.equal(new Set(authors).size, 2, "one event from the person, one from the agent");
  } finally { receiver.close(); delete process.env.FELTKIT_CREDENTIAL_MPHOOK; await t.close(); }
});
