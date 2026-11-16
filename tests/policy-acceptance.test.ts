/**
 * Policy-aware applications, end to end (the 14 acceptance cases). Multiplayer's declarative
 * policies (feltkit/policies.ts) on FeltKit, decided the same way in process, over HTTP and over
 * MCP; agent delegation decided by a real AuthBoundry (FeltKit's authority.local), granted and
 * revoked by the person; durable decision evidence; a managed policy version activated on a running
 * server without a redeploy. Deterministic: no model takes part in any decision.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { api } from "../feltkit/_generated/api.js";
import { ADA, AGENT, MALLORY, addAgent, joinAs, rejects, setup, ARTIFACT } from "./helpers.js";

const require = createRequire(import.meta.url);
const AUTHORITY = (() => { try { require.resolve("@authboundry/local/package.json"); return true; } catch { return false; } })();
const SKIP = ARTIFACT ? "the artifact has no tenancy (see helpers.ts)" : !AUTHORITY ? "@authboundry/local is not installed" : false;

async function boot() {
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  const s = await setup();
  const { t, ada, grace, ws } = s;
  await addAgent(t, ws);
  const agent = t.as(AGENT, { tenant: ws });
  const agentParticipant = (await agent.query(api.me.get, {}))!.participant.id;
  const graceParticipant = (await grace.query(api.me.get, {}))!.participant.id;
  // Ada's channel, with Grace and the room agent in it; Grace's own channel, with the agent in it too.
  const launch = await ada.mutation(api.channels.create, { name: "launch", kind: "public" });
  await ada.mutation(api.channels.addMembers, { channelId: launch, participantIds: [graceParticipant, agentParticipant] });
  const ops = await grace.mutation(api.channels.create, { name: "ops", kind: "public" });
  await grace.mutation(api.channels.addMembers, { channelId: ops, participantIds: [agentParticipant] });
  const decisions = (filter: Record<string, unknown> = {}) => (t.runtime as any).policyStore.decisions(filter) as Promise<any[]>;
  return { ...s, agent, launch, ops, decisions };
}

/** FeltKit's HTTP server on the test runtime: signed-in bearer clients (HTTP functions) and MCP over the same session. */
async function transports(t: any) {
  const { startServer } = await import("@feltdb/feltkit/server");
  const { createClient } = await import("@feltdb/feltkit/client");
  const server = await startServer({ runtime: t.runtime, projectDir: process.cwd(), port: 0, host: "127.0.0.1", dashboard: { enabled: false, adminToken: "", dir: null } });
  const signIn = async (id: string, workspaceId: string) => {
    let token: string | null = null;
    const client = createClient({ url: server.url, tokens: { get: () => token, set: (v) => { token = v; } } });
    await client.signInAsDevUser(id);
    await client.switchTenant(workspaceId);
    const mcp = async (name: string, args: unknown) => {
      const body = await (await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
      return body.result.isError ? { ok: false, text: body.result.content[0].text as string } : { ok: true, value: body.result.structuredContent?.result };
    };
    const tools = async () => (await (await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).json()).result.tools.map((x: any) => x.name) as string[];
    return { client, mcp, tools };
  };
  const anonymous = createClient({ url: server.url, tokens: { get: () => null, set: () => undefined } });
  return { server, signIn, anonymous, close: () => server.close() };
}

test("policy-aware Multiplayer: the 14 acceptance cases", { skip: SKIP }, async () => {
  const { t, ada, grace, mallory, ws, general, malloryWs, agent, launch, ops, decisions } = await boot();
  const net = await transports(t);
  try {
    // 1. An anonymous caller is refused, in process and over HTTP.
    await rejects(t.mutation(api.channels.setTopic, { channelId: launch, topic: "anon" }), "UNAUTHORIZED");
    await rejects(net.anonymous.mutation(api.channels.setTopic, { channelId: launch, topic: "anon" }), "UNAUTHORIZED");

    // 2. A member is allowed what the policy grants a member: the creator of a conversation manages it.
    assert.equal(await grace.mutation(api.channels.setTopic, { channelId: ops, topic: "on call" }), true);

    // 3. Cross-tenant access is refused: Mallory's session is in her own workspace; Acme's records do not exist for her.
    await rejects(mallory.mutation(api.channels.setTopic, { channelId: launch, topic: "pwned" }), ["FORBIDDEN", "NOT_FOUND"]);
    await rejects(mallory.mutation(api.messages.remove, { messageId: (await ada.mutation(api.messages.send, { channelId: general, text: "acme only" })).id }), ["FORBIDDEN", "NOT_FOUND"]);

    // 4. The owner of a record can act on it: Grace edits her own message.
    const graceMsg = await grace.mutation(api.messages.send, { channelId: launch, text: "draft plan" });
    await grace.mutation(api.messages.edit, { messageId: graceMsg.id, text: "final plan" });

    // 5. A non-owner cannot: not another member, and not even the workspace owner (editing is the author's alone).
    await rejects(ada.mutation(api.messages.edit, { messageId: graceMsg.id, text: "rewritten" }), "FORBIDDEN");
    // ... and a member who did not create a conversation cannot manage it (the mismatch the UI hid is closed).
    await rejects(grace.mutation(api.channels.setTopic, { channelId: launch, topic: "hijack" }), "FORBIDDEN");
    const g = await ada.query(api.channels.get, { channelId: launch });
    assert.equal((await grace.query(api.channels.get, { channelId: launch })).canManage, false);
    assert.equal(g.canManage, true);

    // 6. An admin is granted by role: Ada (owner) manages Grace's conversation and moderates Grace's message.
    //    (The conversation hook still applies first: changing a conversation requires being in it.)
    await rejects(ada.mutation(api.channels.setTopic, { channelId: ops, topic: "from outside" }), "FORBIDDEN");
    await ada.mutation(api.channels.join, { channelId: ops });
    assert.equal(await ada.mutation(api.channels.setTopic, { channelId: ops, topic: "on call (24/7)" }), true);
    const stray = await grace.mutation(api.messages.send, { channelId: launch, text: "off topic" });
    await ada.mutation(api.messages.remove, { messageId: stray.id });

    // 7. Context decides: the same person, in a workspace where she is only a member, may not moderate.
    const adaInEvil = await joinAs(t, malloryWs, MALLORY as any, ADA as any, "member");
    const evilGeneral = (await mallory.query(api.channels.list, {})).find((c: any) => c.name === "general")!.id;
    const malloryMsg = await mallory.mutation(api.messages.send, { channelId: evilGeneral, text: "my workspace" });
    const refusedThere = await rejects(adaInEvil.mutation(api.messages.remove, { messageId: malloryMsg.id }), "FORBIDDEN");
    assert.match(refusedThere.message, /No policy allows messages:remove/);

    // 8. An agent performs a delegated action: Ada grants Multiplayer's agents channels.manage in AuthBoundry.
    await rejects(agent.mutation(api.channels.setTopic, { channelId: launch, topic: "by the agent" }), "FORBIDDEN");
    const grant = await ada.action(api.me.delegate, { capabilities: ["channels.manage"] });
    assert.equal(await agent.mutation(api.channels.setTopic, { channelId: launch, topic: "by the agent, for Ada" }), true);
    assert.equal((await ada.query(api.channels.get, { channelId: launch })).topic, "by the agent, for Ada");

    // 9. It cannot exceed the delegation: not Grace's conversation (Grace delegated nothing), not messages.
    await rejects(agent.mutation(api.channels.setTopic, { channelId: ops, topic: "overreach" }), "FORBIDDEN");
    const adaMsg = await ada.mutation(api.messages.send, { channelId: launch, text: "ada's words" });
    await rejects(agent.mutation(api.messages.edit, { messageId: adaMsg.id, text: "agent's words" }), "FORBIDDEN");
    await rejects(agent.mutation(api.messages.remove, { messageId: adaMsg.id }), "FORBIDDEN");

    // 10. Revocation blocks the very next operation.
    await ada.action(api.me.revokeDelegation, { id: grant.id });
    await rejects(agent.mutation(api.channels.setTopic, { channelId: launch, topic: "after revocation" }), "FORBIDDEN");
    assert.equal((await ada.query(api.channels.get, { channelId: launch })).topic, "by the agent, for Ada");

    // 11. HTTP and MCP decide alike, on the same session.
    const graceNet = await net.signIn("grace", ws);
    const adaNet = await net.signIn("ada", ws);
    const tool = (await adaNet.tools()).find((n) => /channels.?settopic/i.test(n)) ?? "";
    assert.ok(tool, "channels.setTopic is published as an MCP tool");
    await rejects(graceNet.client.mutation(api.channels.setTopic, { channelId: launch, topic: "http" }), "FORBIDDEN");
    const graceMcp = await graceNet.mcp(tool, { channelId: launch, topic: "mcp" });
    assert.equal(graceMcp.ok, false);
    assert.match(graceMcp.text ?? "", /No policy allows channels:setTopic/);
    assert.equal(await adaNet.client.mutation(api.channels.setTopic, { channelId: launch, topic: "via http" }), true);
    assert.equal((await adaNet.mcp(tool, { channelId: launch, topic: "via mcp" })).ok, true);
    assert.equal((await ada.query(api.channels.get, { channelId: launch })).topic, "via mcp");

    // 12. Services enforce the same boundaries: an upload link (AppPort Services files) is issued only
    //     inside a conversation the caller may use, and another workspace cannot use it.
    await rejects(mallory.mutation(api.attachments.uploadLink, { channelId: launch, name: "x.txt" }), ["NOT_FOUND", "FORBIDDEN"]);
    const link = await grace.mutation(api.attachments.uploadLink, { channelId: launch, name: "notes.txt", contentType: "text/plain" });
    const file = await net.anonymous.uploadFile(link, new TextEncoder().encode("launch notes"), { name: "notes.txt", contentType: "text/plain" });
    await rejects(mallory.mutation(api.attachments.attach, { channelId: launch, fileId: file.id }), ["NOT_FOUND", "FORBIDDEN"]);
    await rejects(ada.mutation(api.attachments.attach, { channelId: launch, fileId: file.id }), "NOT_FOUND");
    const attached = await grace.mutation(api.attachments.attach, { channelId: launch, fileId: file.id });
    await rejects(mallory.mutation(api.attachments.download, { attachmentId: attached.id }), ["NOT_FOUND", "FORBIDDEN"]);

    // 13. Evidence: every refusal above is a durable decision, naming the layer, the policy version, the
    //     rule that decided (or the unmet conditions), AuthBoundry's decision for delegations — and no argument values.
    const denied = await decisions({ outcome: "denied" });
    const byAgent = denied.filter((d) => d.principal?.id === AGENT.id && d.function === "channels:setTopic");
    assert.ok(byAgent.length >= 3);
    assert.ok(byAgent.every((d) => d.layer === "policy" && /^code:/.test(d.policyVersion)));
    const afterRevoke = byAgent[0];
    assert.equal(afterRevoke.delegations[0].onBehalfOf, "ada");
    assert.equal(afterRevoke.delegations[0].allowed, false);
    const [delegatedAllow] = await decisions({ function: "channels:setTopic", outcome: "allowed", principalId: AGENT.id });
    assert.deepEqual(delegatedAllow.matched, ["channels.manage.delegated"]);
    assert.ok(delegatedAllow.delegations[0].decisionId, "AuthBoundry's decision id");
    const viaMcp = denied.find((d) => d.principal?.id === "grace" && d.via === "mcp");
    const viaHttp = denied.find((d) => d.principal?.id === "grace" && d.via === "http" && d.function === "channels:setTopic");
    assert.ok(viaMcp && viaHttp, "both transports left evidence");
    assert.deepEqual(viaMcp.unmet, viaHttp.unmet, "and the same reasons");
    const moderated = await decisions({ function: "messages:remove", outcome: "allowed" });
    assert.deepEqual(moderated[moderated.length - 1].matched, ["messages.remove.author-or-moderator"]);
    const everything = JSON.stringify(await decisions({ limit: 1000 }));
    for (const value of ["hijack", "overreach", "rewritten", "agent's words", "pwned"]) assert.ok(!everything.includes(value), `no argument value (${value}) in evidence`);

    // 14. A policy change takes effect without a redeploy: a managed version, stored and activated through
    //     the running server's admin API, freezes default channels' topics; deactivating it lifts that.
    const store = (t.runtime as any).policyStore;
    const version = await store.create({ rules: [{ id: "topics.default-frozen", description: "default channels keep their topic", effect: "deny", functions: ["channels:setTopic"], resource: { collection: "channels", id: "channelId" }, when: [{ field: "isDefault", eq: true }] }], note: "freeze #general" }, "ada");
    assert.equal(await adaNet.client.mutation(api.channels.setTopic, { channelId: general, topic: "before" }), true);
    await store.activate(version.version, "ada");
    const frozen = await rejects(adaNet.client.mutation(api.channels.setTopic, { channelId: general, topic: "after" }), "FORBIDDEN");
    assert.match(frozen.message, /topics\.default-frozen/);
    assert.equal(await adaNet.client.mutation(api.channels.setTopic, { channelId: launch, topic: "non-default still fine" }), true);
    const [last] = await decisions({ function: "channels:setTopic", outcome: "denied", principalId: "ada" });
    assert.equal(last.policyVersion, `${(await store.describe()).version}`);
    assert.match(last.policyVersion, /\+managed:1$/);
    await store.activate(null, "ada");
    assert.equal(await adaNet.client.mutation(api.channels.setTopic, { channelId: general, topic: "thawed" }), true);
    assert.deepEqual((await store.history()).map((e: any) => e.action), ["created", "activated", "deactivated"]);
  } finally {
    await net.close();
    await t.close();
  }
});
