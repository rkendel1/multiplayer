import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { ADA, actor, addAgent, AGENT, GRACE, MALLORY, serve, setup, wtest as test } from "./helpers.js";

test("create workspace: owner, default channels, activity", async () => {
  const { t, ada, ws } = await setup();
  try {
    // The workspace and the owner's role are FeltKit's.
    assert.deepEqual((await t.tenancy!.tenantsFor(ADA.id)).map((w) => [w.id, w.name, w.role]), [[ws, "Acme", "owner"]]);
    const w = await ada.query(api.workspaces.get, {});
    assert.deepEqual([w.id, w.name, w.myRole], [ws, "Acme", "owner"]);
    assert.deepEqual(w.members.map((m: any) => m.handle).sort(), ["ada", "grace"]);
    const names = (await ada.query(api.channels.list, { workspaceId: ws })).map((c: any) => c.name).sort();
    assert.deepEqual(names, ["general", "random"]);
    const log = await ada.query(api.activity.list, { workspaceId: ws });
    assert.ok(log.some((a: any) => a.type === "workspace.created"));
    assert.ok(log.some((a: any) => a.type === "membership.joined"), "Grace's acceptance is audited");
  } finally { await t.close(); }
});

test("create channel, invite participant, send message, unread counts", async () => {
  const { t, ada, grace, ws } = await setup();
  try {
    const ch = await ada.mutation(api.channels.create, { workspaceId: ws, name: "Launch Plans", kind: "public" });
    assert.equal((await ada.query(api.channels.get, { channelId: ch })).name, "launch-plans");
    // Grace sees the public channel but is not a member until she joins.
    let mine = (await grace.query(api.channels.list, { workspaceId: ws })).find((c: any) => c.id === ch)!;
    assert.equal(mine.isMember, false);
    await grace.mutation(api.channels.join, { channelId: ch });
    await ada.mutation(api.messages.send, { channelId: ch, text: "hello @grace" });
    await ada.mutation(api.messages.send, { channelId: ch, text: "second" });
    mine = (await grace.query(api.channels.list, { workspaceId: ws })).find((c: any) => c.id === ch)!;
    assert.deepEqual([mine.unread, mine.mentions], [2, 1]);
    assert.equal((await ada.query(api.channels.list, { workspaceId: ws })).find((c: any) => c.id === ch)!.unread, 0, "own messages are read");
    const { items } = await grace.query(api.messages.list, { channelId: ch });
    assert.deepEqual(items.map((m: any) => [m.seq, m.text]), [[1, "hello @grace"], [2, "second"]]);
    await grace.mutation(api.channels.markRead, { channelId: ch, seq: 2 });
    assert.equal((await grace.query(api.channels.list, { workspaceId: ws })).find((c: any) => c.id === ch)!.unread, 0);
    const inbox = await grace.query(api.inbox.list, { unread: true });
    assert.equal(inbox[0]?.type, "mention", "a mention notifies through AppPort Services Notifications");
  } finally { await t.close(); }
});

test("thread replies and reactions", async () => {
  const { t, ada, grace, general } = await setup();
  try {
    const root = await ada.mutation(api.messages.send, { channelId: general, text: "Thread me" });
    await grace.mutation(api.messages.send, { channelId: general, text: "reply 1", rootId: root.id });
    await ada.mutation(api.messages.send, { channelId: general, text: "reply 2", rootId: root.id });
    const th = await grace.query(api.messages.thread, { rootId: root.id });
    assert.deepEqual(th.replies.map((r: any) => r.text), ["reply 1", "reply 2"]);
    assert.equal(th.root.replyCount, 2);
    const top = (await ada.query(api.messages.list, { channelId: general })).items;
    assert.deepEqual(top.map((m: any) => m.text), ["Thread me"], "replies stay in the thread");
    assert.deepEqual(await grace.mutation(api.messages.react, { messageId: root.id, emoji: "🎉" }), { added: true });
    await ada.mutation(api.messages.react, { messageId: root.id, emoji: "🎉" });
    let [m] = (await ada.query(api.messages.list, { channelId: general })).items;
    assert.deepEqual(m.reactions.map((r: any) => [r.emoji, r.count, r.mine]), [["🎉", 2, true]]);
    assert.deepEqual(await ada.mutation(api.messages.react, { messageId: root.id, emoji: "🎉" }), { added: false }, "toggle off");
    [m] = (await ada.query(api.messages.list, { channelId: general })).items;
    assert.deepEqual(m.reactions.map((r: any) => [r.count, r.mine]), [[1, false]]);
  } finally { await t.close(); }
});

test("direct messages and group conversations are found again, not duplicated", async () => {
  const { t, ada, grace, ws } = await setup();
  try {
    const graceId = (await grace.query(api.me.get))!.participant.id;
    const dm = await ada.mutation(api.channels.openConversation, { workspaceId: ws, participantIds: [graceId] });
    assert.equal(await grace.mutation(api.channels.openConversation, { workspaceId: ws, participantIds: [(await ada.query(api.me.get))!.participant.id] }), dm);
    await ada.mutation(api.messages.send, { channelId: dm, text: "psst" });
    const row = (await grace.query(api.channels.list, { workspaceId: ws })).find((c: any) => c.id === dm)!;
    assert.deepEqual([row.kind, row.title, row.unread], ["dm", "Ada Lovelace", 1]);
  } finally { await t.close(); }
});

test("search finds messages in readable conversations only", async () => {
  const { t, ada, grace, ws, general } = await setup();
  try {
    await ada.mutation(api.messages.send, { channelId: general, text: "The Quarterly roadmap is ready" });
    const priv = await ada.mutation(api.channels.create, { workspaceId: ws, name: "secret", kind: "private" });
    await ada.mutation(api.messages.send, { channelId: priv, text: "quarterly numbers (private)" });
    assert.equal((await ada.query(api.messages.search, { workspaceId: ws, q: "QUARTERLY" })).length, 2);
    const g = await grace.query(api.messages.search, { workspaceId: ws, q: "quarterly" });
    assert.deepEqual(g.map((m: any) => m.channel.name), ["general"]);
  } finally { await t.close(); }
});

test("upload an attachment over a file link, send it, download it over a file link", async () => {
  const { t, ada, grace, general } = await setup();
  const http = await serve(t);
  try {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 10, 13]);
    const { attachment: a } = await http.upload(ada, general, "data.bin", bytes);
    assert.equal(a.size, bytes.length);
    await ada.mutation(api.messages.send, { channelId: general, text: "see file", attachmentIds: [a.id] });
    const [m] = (await grace.query(api.messages.list, { channelId: general })).items;
    assert.equal(m.attachments[0].name, "data.bin");
    const d = await grace.mutation(api.attachments.download, { attachmentId: a.id });
    assert.match(d.url, /^\/api\/files\//);
    assert.deepEqual([...(await http.download(d))], [...bytes], "bytes round-trip exactly, over HTTP");
    assert.equal((await grace.query(api.attachments.list, { channelId: general })).length, 1);
  } finally { await http.close(); await t.close(); }
});

test("add agent, mention it, agent action persists a project plan and posts a reference", async () => {
  const { t, ada, ws } = await setup();
  try {
    // The agent is a FeltKit member of the workspace (role "agent"), added directly as an agent identity.
    await addAgent(t, ws);
    assert.equal((await t.tenancy!.membership(ws, "assistant"))?.role, "agent");
    const ch = await ada.mutation(api.channels.create, { workspaceId: ws, name: "launch", kind: "public", topic: "Q1 launch" });
    await ada.mutation(api.messages.send, { channelId: ch, text: "Goal: ship the beta by March 14." });
    await ada.mutation(api.messages.send, { channelId: ch, text: "Decided: per-seat pricing." });
    await ada.mutation(api.messages.send, { channelId: ch, text: "I'll write the launch post by Feb 28." });
    await ada.mutation(api.messages.send, { channelId: ch, text: "Risk: SSO vendor is flaky." });
    const ask = await ada.mutation(api.messages.send, { channelId: ch, text: "@assistant summarize this discussion and create a project plan." });
    // One request recorded with the message; the run itself starts after the commit (it may already be done).
    const queued = await ada.query(api.agents.requests, { channelId: ch });
    assert.equal(queued.length, 1);
    assert.ok(["pending", "done"].includes(queued[0].status), queued[0].status);

    // FeltKit runs the app.agent after the commit, as the agent (here: wait for it).
    await t.runtime.settleAgents();

    const [req] = await ada.query(api.agents.requests, { channelId: ch });
    assert.equal(req.status, "done");
    const th = await ada.query(api.messages.thread, { rootId: ask.id });
    const reply = th.replies[0];
    assert.equal(reply.author.handle, "assistant");
    assert.ok(reply.shared, "the reply references the persisted plan");
    const plan = await ada.query(api.agents.plan, { id: reply.shared.id });
    assert.equal(plan.kind, "project_plan");
    assert.deepEqual(plan.decisions, ["per-seat pricing"]);
    assert.deepEqual(plan.risks, ["SSO vendor is flaky"]);
    assert.deepEqual(plan.tasks.map((x: any) => [x.owner, x.due]), [["Ada Lovelace", "by Feb 28"]]);
    assert.equal((await ada.query(api.agents.plans, { workspaceId: ws })).length, 1);
    const log = await ada.query(api.activity.list, { workspaceId: ws });
    assert.ok(log.some((a: any) => a.type === "agent.plan.created"));
    // Run as the agent's own principal, recorded in FeltKit's activity log, once.
    await t.runtime.activity.flush();
    const runs = (await t.runtime.activity.list()).filter((e: any) => e.name === "agent/assistant");
    assert.deepEqual(runs.map((e: any) => [e.principal?.id, e.via, e.outcome]), [["assistant", "agent", "success"]]);
    await t.runtime.runServices();
    assert.equal((await ada.query(api.messages.thread, { rootId: ask.id })).replies.length, 1, "the services worker does not run it again");
  } finally { await t.close(); }
});

test("state survives a restart (durable recovery)", async () => {
  const { t, ada, general, ws } = await setup();
  try {
    await ada.mutation(api.messages.send, { channelId: general, text: "durable" });
    await t.restart();
    const again = t.as(ADA, { tenant: ws });
    assert.equal((await again.query(api.messages.list, { channelId: general })).items[0].text, "durable");
    assert.equal((await t.tenancy!.membership(ws, GRACE.id))?.role, "member", "memberships are durable too");
  } finally { await t.close(); }
});

test("the sample workspace is real, persisted and complete", async () => {
  const { t } = await setup();
  try {
    // What the client does: create the workspace (FeltKit), add the room agent (FeltKit), seed it.
    const ws = (await t.tenancy!.create("Northwind Labs", GRACE)).id;
    const grace = t.as(GRACE, { tenant: ws });
    await grace.mutation(api.me.ensure, {});
    await t.tenancy!.addPrincipal({ ...(await t.tenancy!.context(ws, GRACE.id))!, principalId: GRACE.id }, { id: "assistant", type: "agent" }, "agent");
    assert.equal(await grace.mutation(api.demo.seed, {}), ws);
    const w = await grace.query(api.workspaces.get, { workspaceId: ws });
    assert.deepEqual([w.name, w.myRole], ["Northwind Labs", "owner"]);
    assert.ok(w.members.some((m: any) => m.handle === "assistant" && m.kind === "agent"));
    const chans = await grace.query(api.channels.list, { workspaceId: ws });
    assert.deepEqual(chans.filter((c: any) => c.kind !== "dm").map((c: any) => c.name).sort(), ["design-crit", "general", "launch-q1", "random"]);
    assert.equal(chans.find((c: any) => c.kind === "dm")!.unread, 1);
    assert.equal(chans.find((c: any) => c.name === "general")!.isMember, true);
    // Only into an empty workspace.
    await assert.rejects(grace.mutation(api.demo.seed, {}), { code: "FAILED_PRECONDITION" });
  } finally { await t.close(); }
});

test("the room agent works in every workspace it is a member of, and in none it was removed from", async () => {
  const { t, ada, ws, general, mallory, malloryWs } = await setup();
  try {
    await addAgent(t, ws);
    await addAgent(t, malloryWs, MALLORY);
    const evil = (await mallory.query(api.channels.list, {})).find((c: any) => c.name === "general")!.id;
    await ada.mutation(api.messages.send, { channelId: general, text: "@assistant summarize this" });
    await mallory.mutation(api.messages.send, { channelId: evil, text: "@assistant summarize ours" });
    await t.runtime.settleAgents();
    for (const [who, ch] of [[ada, general], [mallory, evil]] as const) {
      const [top] = (await who.query(api.messages.list, { channelId: ch })).items;
      assert.equal((await who.query(api.messages.thread, { rootId: top.id })).replies[0].author.handle, "assistant");
      assert.deepEqual((await who.query(api.agents.requests, { channelId: ch })).map((r: any) => r.status), ["done"]);
    }
    // Removed from Acme (FeltKit): @assistant is no longer a mention there, so nothing is asked of it.
    await t.tenancy!.remove(await actor(t, ws, ADA), AGENT.id);
    const again = await ada.mutation(api.messages.send, { channelId: general, text: "@assistant again?" });
    await t.runtime.settleAgents();
    assert.equal((await ada.query(api.agents.requests, { channelId: general })).length, 1);
    assert.equal((await ada.query(api.messages.thread, { rootId: again.id })).replies.length, 0);
  } finally { await t.close(); }
});

test("live queries re-run only for writes they can see (predicates on declared fields)", async () => {
  const { t, ada, ws, general } = await setup();
  const http = await serve(t);
  try {
    const random = (await ada.query(api.channels.list, {})).find((c: any) => c.name === "random")!.id;
    const grace = await http.signIn("grace", ws);
    // Every read of these queries is an equality on a declared field (id, reference, index, tenant),
    // so FeltKit records keyed predicates for each collection, not whole-collection reads.
    for (const [fn, args] of [[api.messages.list, { channelId: general }], [api.channels.get, { channelId: general }], [api.attachments.list, { channelId: general }], [api.agents.requests, { channelId: general }]] as const) {
      const { reads } = await grace.queryWithReads(fn as any, args as any);
      const names = reads.filter((r) => !r.includes("#"));
      for (const name of names) assert.ok(reads.some((r) => r.startsWith(`${name}#`)), `${fn.name} reads ${name} by a keyed predicate`);
    }
    let runs = 0;
    let last: any = null;
    const off = grace.watchQuery(api.messages.list, { channelId: general }, { next: (v) => { runs++; last = v; } });
    const settle = async (pred: () => boolean) => { for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 300)); };
    await settle(() => runs > 0);
    const before = runs;
    await ada.mutation(api.messages.send, { channelId: random, text: "elsewhere" });
    await settle(() => false);
    assert.equal(runs, before, "a post in #random does not re-run #general's messages");
    await ada.mutation(api.messages.send, { channelId: general, text: "here" });
    await settle(() => last?.items.some((m: any) => m.text === "here"));
    assert.ok(runs > before && last.items.some((m: any) => m.text === "here"), "a post in #general does");
    off();
  } finally { await http.close(); await t.close(); }
});
