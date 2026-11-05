import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { ADA, actor, addAgent, AGENT, ALAN, GRACE, joinAs, MALLORY, rejects, serve, setup, wtest as test } from "./helpers.js";

test("unauthorized workspace access: outsiders are refused everywhere", async () => {
  const { t, ada, mallory, ws, general } = await setup();
  try {
    // Mallory works in her own workspace: naming Acme or its records finds nothing.
    await rejects(mallory.query(api.workspaces.get, { workspaceId: ws }), "NOT_FOUND");
    await rejects(mallory.query(api.channels.list, { workspaceId: ws }), "NOT_FOUND");
    await rejects(mallory.query(api.activity.list, { workspaceId: ws }), "NOT_FOUND");
    await rejects(mallory.query(api.messages.list, { channelId: general }), "NOT_FOUND");
    await rejects(mallory.mutation(api.messages.send, { channelId: general, text: "hi" }), "NOT_FOUND");
    await rejects(mallory.mutation(api.channels.join, { channelId: general }), "NOT_FOUND");
    const root = await ada.mutation(api.messages.send, { channelId: general, text: "x" });
    await rejects(mallory.mutation(api.messages.react, { messageId: root.id, emoji: "👍" }), "NOT_FOUND");
    await rejects(mallory.query(api.messages.thread, { rootId: root.id }), "NOT_FOUND");
    // Asking FeltKit to work in Acme: she is not a member, so she holds no workspace role there.
    await rejects(t.as(MALLORY, { tenant: ws }).query(api.channels.list, {}), "FORBIDDEN");
    // Signed in, but no workspace chosen: no workspace permissions at all.
    await rejects(t.as(MALLORY).query(api.channels.list, {}), "FORBIDDEN");
    await rejects(t.query(api.channels.list, { workspaceId: ws }), "UNAUTHORIZED");
  } finally { await t.close(); }
});

test("a forged workspaceId argument is refused: the workspace is the session's", async () => {
  const { t, ada, mallory, ws, malloryWs, general } = await setup();
  try {
    // Ada (in Acme) names Mallory's workspace, and Mallory (in Evil Corp) names Acme: both NOT_FOUND,
    // whichever function, even where the id is otherwise unused.
    for (const [who, other] of [[ada, malloryWs], [mallory, ws]] as const) {
      await rejects(who.query(api.workspaces.get, { workspaceId: other }), "NOT_FOUND");
      await rejects(who.query(api.messages.search, { workspaceId: other, q: "x" }), "NOT_FOUND");
      await rejects(who.mutation(api.channels.create, { workspaceId: other, name: "x", kind: "public" }), "NOT_FOUND");
      await rejects(who.mutation(api.presence.heartbeat, { workspaceId: other, status: "active" }), "NOT_FOUND");
      await rejects(who.query(api.agents.plans, { workspaceId: other }), "NOT_FOUND");
    }
    // A record the caller creates always lands in the session's workspace.
    const c = await ada.mutation(api.channels.create, { name: "mine", kind: "public" });
    assert.equal((await ada.query(api.channels.get, { channelId: c })).workspaceId, ws);
    await rejects(mallory.query(api.channels.get, { channelId: c }), "NOT_FOUND");
    await rejects(mallory.query(api.messages.list, { channelId: general }), "NOT_FOUND");
  } finally { await t.close(); }
});

test("cross-tenant queries: client-supplied ids from another workspace are refused", async () => {
  const { t, ada, mallory, ws, general, malloryWs } = await setup();
  try {
    // Mallory, inside her own workspace, names Acme's channel: refused, nothing leaks into search.
    await ada.mutation(api.messages.send, { channelId: general, text: "acme secret plans" });
    assert.deepEqual(await mallory.query(api.messages.search, { workspaceId: malloryWs, q: "secret" }), []);
    await rejects(mallory.query(api.messages.search, { workspaceId: ws, q: "secret" }), "NOT_FOUND");
    // Open a DM with someone in another workspace: refused.
    const adaId = (await ada.query(api.me.get))!.participant.id;
    await rejects(mallory.mutation(api.channels.openConversation, { participantIds: [adaId] }), "NOT_FOUND");
    // Add Ada to a channel in Mallory's workspace: refused.
    const evil = await mallory.mutation(api.channels.create, { name: "trap", kind: "private" });
    await rejects(mallory.mutation(api.channels.addMembers, { channelId: evil, participantIds: [adaId] }), "NOT_FOUND");
    // Mention someone outside the workspace: no notification, no mention recorded.
    const sent = await mallory.mutation(api.messages.send, { channelId: evil, text: "@ada look" });
    const [m] = (await mallory.query(api.messages.list, { channelId: evil })).items;
    assert.equal(m.id, sent.id);
    assert.deepEqual(m.mentions, []);
    assert.deepEqual((await ada.query(api.inbox.list, { unread: true })).filter((n: any) => n.type === "mention"), []);
  } finally { await t.close(); }
});

test("unauthorized channel access: private channels are invisible to non-members", async () => {
  const { t, ada, grace, ws } = await setup();
  try {
    const priv = await ada.mutation(api.channels.create, { workspaceId: ws, name: "leadership", kind: "private" });
    await ada.mutation(api.messages.send, { channelId: priv, text: "confidential" });
    assert.ok(!(await grace.query(api.channels.list, { workspaceId: ws })).some((c: any) => c.id === priv));
    await rejects(grace.query(api.messages.list, { channelId: priv }), "NOT_FOUND");
    await rejects(grace.query(api.channels.get, { channelId: priv }), "NOT_FOUND");
    await rejects(grace.mutation(api.channels.join, { channelId: priv }), "NOT_FOUND");
    await rejects(grace.mutation(api.presence.typingIn, { channelId: priv, typing: true }), "NOT_FOUND");
    const graceId = (await grace.query(api.me.get))!.participant.id;
    await ada.mutation(api.channels.addMembers, { channelId: priv, participantIds: [graceId] });
    assert.equal((await grace.query(api.messages.list, { channelId: priv })).items[0].text, "confidential");
  } finally { await t.close(); }
});

test("unauthorized direct-message access: only the participants", async () => {
  const { t, ada, grace, ws } = await setup();
  try {
    const alan = await joinAs(t, ws, ADA, ALAN, "member");
    const graceId = (await grace.query(api.me.get))!.participant.id;
    const dm = await ada.mutation(api.channels.openConversation, { workspaceId: ws, participantIds: [graceId] });
    await ada.mutation(api.messages.send, { channelId: dm, text: "between us" });
    await rejects(alan.query(api.messages.list, { channelId: dm }), "NOT_FOUND");
    await rejects(alan.mutation(api.messages.send, { channelId: dm, text: "hi" }), "NOT_FOUND");
    assert.equal((await alan.query(api.messages.search, { workspaceId: ws, q: "between" })).length, 0);
    // Even the workspace owner cannot read a DM they are not in.
    const alanId = (await alan.query(api.me.get))!.participant.id;
    const gdm = await grace.mutation(api.channels.openConversation, { workspaceId: ws, participantIds: [alanId] });
    await rejects(ada.query(api.messages.list, { channelId: gdm }), "NOT_FOUND");
  } finally { await t.close(); }
});

test("role-based access and invitation authorization (FeltKit's tenancy routes)", async () => {
  const { t, ws } = await setup();
  const http = await serve(t);
  try {
    const ada = await http.signIn("ada", ws);
    const grace = await http.signIn("grace", ws);
    // Members cannot invite, change roles, add members or rename the workspace: FeltKit's
    // tenant.members.manage / tenant.update come only with the admin and owner roles.
    await rejects(grace.invite({ email: "x@example.com", role: "guest", send: false }), "FORBIDDEN");
    await rejects(grace.setMemberRole("grace", "admin"), "FORBIDDEN");
    await rejects(grace.addMember("assistant", "agent"), "FORBIDDEN");
    await rejects(grace.renameTenant("Mine"), "FORBIDDEN");
    await rejects(grace.invitations(), "FORBIDDEN");
    // Admins invite and manage, but only below their own role; only the owner makes admins or renames.
    await ada.setMemberRole("grace", "admin");
    await rejects(grace.invite({ email: "x@example.com", role: "admin", send: false }), "FORBIDDEN");
    await rejects(grace.renameTenant("Mine"), "FORBIDDEN");
    const guestInv = await grace.invite({ email: "alan@example.com", role: "guest", send: false });
    // The link carries FeltKit's invitation token (HMAC, never stored); the invitation id is not one.
    const token = /#feltkit-invitation=(fki_[A-Za-z0-9_-]+)/.exec(guestInv.link)![1]!;
    await rejects((await http.signIn("alan")).acceptInvitation(guestInv.invitation.id), "NOT_FOUND");
    // Guests: see only channels they are added to (not public ones), cannot create channels.
    const alan = await http.signIn("alan");
    await alan.acceptInvitation(token);
    await alan.mutation(api.me.ensure, {});
    assert.deepEqual(await alan.query(api.channels.list, {}), []);
    await rejects(alan.mutation(api.channels.create, { name: "x", kind: "public" }), "FORBIDDEN");
    await rejects(alan.query(api.activity.list, {}), "FORBIDDEN");
    // Invitations work once, and revoked ones never.
    await rejects((await http.signIn("grace")).acceptInvitation(token), "FAILED_PRECONDITION");
    const inv = await ada.invite({ email: "alan@example.com", role: "member", send: false });
    await ada.revokeInvitation(inv.invitation.id);
    await rejects(alan.acceptInvitation(/#feltkit-invitation=(fki_[A-Za-z0-9_-]+)/.exec(inv.link)![1]!), "FAILED_PRECONDITION");
    // A role FeltKit does not declare is refused; the app's own access check still applies to a principal without roles.
    await rejects(ada.setMemberRole("grace", "superuser"), "INVALID_ARGUMENT");
    await rejects(t.as({ id: "noroles", type: "user", roles: [] }).query(api.channels.list, {}), "FORBIDDEN");
  } finally { await http.close(); await t.close(); }
});

test("unauthorized membership changes", async () => {
  const { t, ws } = await setup();
  const http = await serve(t);
  try {
    const ada = await http.signIn("ada", ws);
    const grace = await http.signIn("grace", ws);
    await rejects(grace.removeMember("ada"), "FORBIDDEN");
    // The last owner can neither leave nor step down.
    await rejects(ada.leaveTenant(), "FAILED_PRECONDITION");
    await rejects(ada.setMemberRole("ada", "member"), "FAILED_PRECONDITION");
    await ada.setMemberRole("grace", "admin");
    // An admin cannot remove the owner, or another admin.
    await rejects(grace.removeMember("ada"), "FORBIDDEN");
    await ada.removeMember("grace");
    await rejects(t.as(GRACE, { tenant: ws }).query(api.workspaces.get, {}), "FORBIDDEN");
    assert.deepEqual((await ada.members()).map((m) => m.principalId), ["ada"]);
  } finally { await http.close(); await t.close(); }
});

test("a removed membership is refused on the next call", async () => {
  const { t, grace, ws, general } = await setup();
  try {
    await grace.mutation(api.messages.send, { channelId: general, text: "still here" });
    await t.tenancy!.remove(await actor(t, ws, ADA), GRACE.id);
    // The same caller (same session), next call: no workspace, no workspace role, nothing readable.
    await rejects(grace.query(api.messages.list, { channelId: general }), "FORBIDDEN");
    await rejects(grace.mutation(api.messages.send, { channelId: general, text: "back door" }), "FORBIDDEN");
    await rejects(grace.query(api.workspaces.get, {}), "FORBIDDEN");
    assert.equal((await t.tenancy!.tenantsFor(GRACE.id)).length, 0);
  } finally { await t.close(); }
});

test("a role change takes effect on the next call", async () => {
  const { t, ws, general } = await setup();
  try {
    const alan = await joinAs(t, ws, ADA, ALAN, "member");
    assert.ok((await alan.query(api.channels.list, {})).some((c: any) => c.id === general));
    const c = await alan.mutation(api.channels.create, { name: "alans", kind: "public" });
    // Made a guest: public channels he is not in disappear, creating channels is refused.
    await t.tenancy!.setRole(await actor(t, ws, ADA), ALAN.id, "guest");
    await rejects(alan.mutation(api.channels.create, { name: "more", kind: "public" }), "FORBIDDEN");
    await rejects(alan.query(api.activity.list, {}), "FORBIDDEN");
    const ada = t.as(ADA, { tenant: ws });
    const other = await ada.mutation(api.channels.create, { name: "ada-only", kind: "public" });
    await rejects(alan.query(api.messages.list, { channelId: other }), "NOT_FOUND");
    assert.ok(!(await alan.query(api.channels.list, {})).some((x: any) => x.id === other));
    assert.ok((await alan.query(api.channels.list, {})).some((x: any) => x.id === c), "channels he was in stay readable");
    // Back to member: at once.
    await t.tenancy!.setRole(await actor(t, ws, ADA), ALAN.id, "member");
    assert.ok((await alan.query(api.channels.list, {})).some((x: any) => x.id === other));
    assert.equal((await alan.query(api.workspaces.get, {})).myRole, "member");
  } finally { await t.close(); }
});

test("unauthorized file access", async () => {
  const { t, ada, grace, mallory, ws } = await setup();
  const http = await serve(t);
  try {
    const priv = await ada.mutation(api.channels.create, { workspaceId: ws, name: "files", kind: "private" });
    const general = (await ada.query(api.channels.list, { workspaceId: ws })).find((c: any) => c.name === "general")!.id;
    const { file, attachment: a } = await http.upload(ada, priv, "secret.txt", new TextEncoder().encode("top secret"), "text/plain");
    await ada.mutation(api.messages.send, { channelId: priv, text: "file", attachmentIds: [a.id] });
    // Download links are issued only to readers of the conversation.
    await rejects(grace.mutation(api.attachments.download, { attachmentId: a.id }), "NOT_FOUND");
    await rejects(mallory.mutation(api.attachments.download, { attachmentId: a.id }), "NOT_FOUND");
    await rejects(mallory.query(api.attachments.list, { channelId: priv }), "NOT_FOUND");
    // Upload links only for conversations the caller is in.
    await rejects(grace.mutation(api.attachments.uploadLink, { channelId: priv, name: "x" }), "NOT_FOUND");
    await rejects(mallory.mutation(api.attachments.uploadLink, { channelId: general, name: "x" }), "NOT_FOUND");
    // A file is bound only by its uploader, only to the conversation its link was issued for, and once.
    await rejects(grace.mutation(api.attachments.attach, { channelId: general, fileId: file.id }), "NOT_FOUND");
    await rejects(ada.mutation(api.attachments.attach, { channelId: general, fileId: file.id }), "NOT_FOUND");
    await rejects(ada.mutation(api.attachments.attach, { channelId: priv, fileId: file.id }), "NOT_FOUND");
    const evil = (await mallory.query(api.channels.list, {})).find((c: any) => c.name === "general")!.id;
    const theirs = await http.upload(mallory, evil, "x.txt", new TextEncoder().encode("x"));
    await rejects(ada.mutation(api.attachments.attach, { channelId: general, fileId: theirs.file.id }), "NOT_FOUND");
    // An attachment cannot be re-attached by someone else, or into another conversation.
    await rejects(grace.mutation(api.messages.send, { channelId: general, text: "steal", attachmentIds: [a.id] }), "NOT_FOUND");
    await rejects(ada.mutation(api.messages.send, { channelId: general, text: "move", attachmentIds: [a.id] }), "NOT_FOUND");
    // A forged or used link is refused by FeltKit.
    assert.equal((await fetch(`${http.url}/api/files/forged`)).status, 404);
  } finally { await http.close(); await t.close(); }
});

test("agent permission escalation is refused at every layer", async () => {
  const { t, ada, grace, ws, general } = await setup();
  try {
    // Not a FeltKit member yet: it has a profile, but @assistant is not a mention here; nothing is asked of it.
    await ada.mutation(api.agents.add, {});
    const early = await ada.mutation(api.messages.send, { channelId: general, text: "@assistant are you there?" });
    await t.runtime.settleAgents();
    assert.deepEqual(await ada.query(api.agents.requests, { channelId: general }), []);
    assert.equal((await ada.query(api.messages.thread, { rootId: early.id })).replies.length, 0);
    await addAgent(t, ws);
    const agent = t.as(AGENT, { tenant: ws });
    // Role layer: the agent's principal cannot call people's functions at all.
    await rejects(agent.mutation(api.channels.create, { name: "x", kind: "public" }), "FORBIDDEN");
    await rejects(agent.mutation(api.agents.add, {}), "FORBIDDEN");
    await rejects(agent.query(api.attachments.list, { channelId: general }), "FORBIDDEN");
    await rejects(agent.mutation(api.demo.seed, {}), "FORBIDDEN");
    // FeltKit's layer: an agent member cannot give roles above its own; people never join directly.
    await rejects(t.tenancy!.addPrincipal(await actor(t, ws, AGENT), { id: "rogue", type: "agent" }, "admin"), "FORBIDDEN");
    await rejects(t.tenancy!.addPrincipal(await actor(t, ws, ADA), { id: "mallory", type: "user" }, "member"), "FORBIDDEN");
    // Channel layer: it does not see public channels it was not brought into.
    await rejects(agent.query(api.messages.list, { channelId: general }), "NOT_FOUND");
    // Nobody runs the agent by name: only a committed mention triggers it.
    await assert.rejects(ada.mutation({ name: "agent/assistant" } as any, { requestId: "x" }));
    // A private conversation does not open up to it through someone outside it.
    const priv = await ada.mutation(api.channels.create, { workspaceId: ws, name: "board", kind: "private" });
    await ada.mutation(api.messages.send, { channelId: priv, text: "confidential board notes" });
    await rejects(grace.mutation(api.messages.send, { channelId: priv, text: "@assistant summarize" }), "NOT_FOUND");
    // Mentioned in #general, it answers from #general only, as itself.
    const ask = await grace.mutation(api.messages.send, { channelId: general, text: "@assistant summarize this" });
    await t.runtime.settleAgents();
    const [reply] = (await ada.query(api.messages.thread, { rootId: ask.id })).replies;
    assert.equal(reply.author.handle, "assistant");
    assert.ok(!reply.text.includes("confidential"));
    await rejects(agent.query(api.messages.list, { channelId: priv }), "NOT_FOUND");
    // Another agent identity, even a member, is not the room agent: mentioning it triggers nothing.
    const ROGUE = { id: "rogue-bot", type: "agent" as const, roles: ["agent"] };
    await t.tenancy!.addPrincipal(await actor(t, ws, ADA), ROGUE, "agent");
    await t.as(ROGUE, { tenant: ws }).mutation(api.me.ensure, {});
    await ada.mutation(api.messages.send, { channelId: general, text: "@rogue-bot do something" });
    await t.runtime.settleAgents();
    assert.equal((await ada.query(api.agents.requests, { channelId: general })).length, 1);
  } finally { await t.close(); }
});

test("overlapping agent runs: each mention is answered exactly once", async () => {
  const { t, ada, grace, ws, general } = await setup();
  try {
    await addAgent(t, ws);
    // Three mentions committed back to back: their runs start at once and overlap.
    const asks = [];
    for (const [who, n] of [[ada, "one"], [grace, "two"], [ada, "three"]] as const) asks.push(await who.mutation(api.messages.send, { channelId: general, text: `@assistant summarize ${n}` }));
    // A run that lost the conversation's sequence to another is retried after a short backoff.
    for (let i = 0; i < 40; i++) {
      await t.runtime.settleAgents();
      await t.runtime.runServices();
      if ((await ada.query(api.agents.requests, { channelId: general })).every((r: any) => r.status !== "pending")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const ask of asks) {
      const replies = (await ada.query(api.messages.thread, { rootId: ask.id })).replies;
      assert.equal(replies.filter((r: any) => r.author.handle === "assistant").length, 1);
    }
    assert.deepEqual((await ada.query(api.agents.requests, { channelId: general })).map((r: any) => r.status), ["done", "done", "done"]);
  } finally { await t.close(); }
});

test("a removed member is no longer in the directory: no mention, no notification, no new DM", async () => {
  const { t, ada, grace, ws, general } = await setup();
  try {
    const graceId = (await grace.query(api.me.get))!.participant.id;
    await ada.mutation(api.messages.send, { channelId: general, text: "@grace before" });
    assert.equal((await t.as(GRACE).query(api.inbox.list, { unread: true })).filter((n: any) => n.type === "mention").length, 1);
    await t.tenancy!.remove(await actor(t, ws, ADA), GRACE.id);
    assert.ok(!(await ada.query(api.workspaces.get, {})).members.some((m: any) => m.participantId === graceId));
    const sent = await ada.mutation(api.messages.send, { channelId: general, text: "@grace after" });
    const m = (await ada.query(api.messages.list, { channelId: general })).items.find((x: any) => x.id === sent.id)!;
    assert.deepEqual(m.mentions, []);
    assert.equal((await t.as(GRACE).query(api.inbox.list, { unread: true })).filter((n: any) => n.type === "mention").length, 1, "only the mention from before the removal");
    await rejects(ada.mutation(api.channels.openConversation, { participantIds: [graceId] }), "NOT_FOUND");
    const priv = await ada.mutation(api.channels.create, { name: "after", kind: "private" });
    await rejects(ada.mutation(api.channels.addMembers, { channelId: priv, participantIds: [graceId] }), "NOT_FOUND");
  } finally { await t.close(); }
});

test("typing events (app.event) reach only those who can read the conversation", async () => {
  const { t, ada, ws, general } = await setup();
  const http = await serve(t);
  try {
    const priv = await ada.mutation(api.channels.create, { name: "quiet", kind: "private" });
    const grace = await http.signIn("grace", ws);
    // Grace listens to the private conversation (she cannot read it) and to #general (she can).
    const secret: any[] = [];
    const got: any[] = [];
    const offSecret = grace.subscribe("conversation.typing", { scope: priv }, (p) => secret.push(p));
    const off = grace.subscribe("conversation.typing", { scope: general }, (p) => got.push(p));
    for (let i = 0; i < 50 && !got.length; i++) {
      await ada.mutation(api.presence.typingIn, { channelId: priv, typing: true });
      await ada.mutation(api.presence.typingIn, { channelId: general, typing: true });
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < 5; i++) {
      await ada.mutation(api.presence.typingIn, { channelId: priv, typing: true });
      await new Promise((r) => setTimeout(r, 100));
    }
    offSecret();
    assert.deepEqual(secret, [], "nothing from a conversation she cannot read");
    off();
    assert.equal(got[0]?.name, "Ada Lovelace");
    assert.equal(got[0]?.typing, true);
  } finally { await http.close(); await t.close(); }
});

test("guests hold least privilege: only what working inside their conversations needs", async () => {
  const { t, ada, ws, general } = await setup();
  const alan = await joinAs(t, ws, ADA, ALAN, "guest");
  const alanMe = await alan.query(api.me.get, {});
  await ada.mutation(api.channels.addMembers, { channelId: general, participantIds: [alanMe!.participant!.id] });
  // Inside a conversation he was added to: read, write, mark read, presence.
  await alan.mutation(api.messages.send, { channelId: general, text: "hello from a guest" });
  const list = await alan.query(api.messages.list, { channelId: general });
  const mine = list.items.find((m) => m.text === "hello from a guest");
  assert.ok(mine, "the guest's message is in the conversation");
  await alan.mutation(api.channels.markRead, { channelId: general, seq: mine.seq });
  await alan.mutation(api.presence.heartbeat, { status: "active" });
  // Nothing beyond it, refused by the role itself (not narrowed later by the conversation policy).
  await rejects(alan.mutation(api.channels.create, { name: "guest-made", kind: "public" }), "FORBIDDEN");
  await rejects(alan.mutation(api.channels.join, { channelId: general }), "FORBIDDEN");
  await rejects(alan.mutation(api.channels.setTopic, { channelId: general, topic: "x" }), "FORBIDDEN");
  await rejects(alan.mutation(api.channels.addMembers, { channelId: general, participantIds: [alanMe!.participant!.id] }), "FORBIDDEN");
  await rejects(alan.mutation(api.channels.openConversation, { participantIds: [alanMe!.participant!.id] }), "FORBIDDEN");
  await rejects(alan.query(api.agents.plans, {}), "FORBIDDEN");
  await rejects(alan.query(api.activity.list, {}), "FORBIDDEN");
  await rejects(alan.mutation(api.agents.add, {}), "FORBIDDEN");
  await rejects(alan.mutation(api.demo.seed, {}), "FORBIDDEN");
  await t.close();
});

test("the role table is least privilege: no wildcard grants to workspace roles, each role adds to the one below", async () => {
  const { app } = await import("../feltkit/app.js");
  const roles = app.options.roles!;
  const order = ["guest", "member", "admin", "owner"] as const;
  for (const role of ["guest", "member", "admin"] as const) {
    assert.ok(!roles[role]!.some((p) => p === "*" || p.endsWith(".*")), `${role} holds no wildcard permission`);
  }
  for (let i = 1; i < order.length; i++) {
    const below = new Set(roles[order[i - 1]!]);
    assert.ok([...below].every((p) => roles[order[i]!]!.includes(p)), `${order[i]} includes everything ${order[i - 1]} holds`);
  }
  // Admin-only and owner-only actions are permissions those roles alone hold.
  assert.ok(!roles.member!.includes("agents.manage") && roles.admin!.includes("agents.manage"));
  assert.ok(!roles.admin!.includes("workspaces.seed") && roles.owner!.includes("workspaces.seed"));
});
