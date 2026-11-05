import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createArtifactTestApp, createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

/** Principals as FeltKit's tenancy store takes them (the dev users of feltkit/app.ts, and outsiders). */
export const ADA = { id: "ada", type: "user" as const, displayName: "Ada Lovelace", roles: ["person", "operator"] };
export const GRACE = { id: "grace", type: "user" as const, displayName: "Grace Hopper", roles: ["person"] };
export const ALAN = { id: "alan", type: "user" as const, displayName: "Alan Turing", roles: ["person"] };
export const MALLORY = { id: "mallory", type: "user" as const, displayName: "Mallory", roles: ["person"] };
export const AGENT = { id: "assistant", type: "agent" as const, displayName: "Assistant", roles: ["agent"] };

/** MP_TARGET=artifact runs the tests against the compiled AppBoundry artifact (multiplayer.app) instead. */
export const ARTIFACT = process.env.MP_TARGET === "artifact";
const NO_TENANCY = "MP_TARGET=artifact is blocked: AppBoundry hosts have no accounts or tenancy, and `feltkit build --target appboundry` refuses app.agent (the room agent), so no artifact of this app exists. Not faked: skipped.";

/** A test that needs workspaces (FeltKit tenancy). Skipped, with the reason, against the artifact. */
export function wtest(name: string, fn: () => Promise<void>) {
  return ARTIFACT ? test(name, { skip: NO_TENANCY }, fn) : test(name, fn);
}

/** The app under test: FeltKit's runtime, or the artifact in AppBoundry's reference host on durable state. */
export async function createApp(): Promise<any> {
  if (!ARTIFACT) return createTestApp();
  const stateDir = mkdtempSync(join(tmpdir(), "mp-artifact-"));
  let app = await createArtifactTestApp("multiplayer.app", { stateDir });
  return {
    as: (who: any) => ({ query: (f: any, a?: any) => app.as(who).query(f, a), mutation: (f: any, a?: any) => app.as(who).mutation(f, a) }),
    query: (f: any, a?: any) => app.query(f, a),
    mutation: (f: any, a?: any) => app.mutation(f, a),
    restart: async () => { await app.close(); app = await createArtifactTestApp("multiplayer.app", { stateDir }); },
    close: () => app.close(),
    runtime: null,
    tenancy: null,
  };
}

/** The context FeltKit's tenancy store wants for an actor: their live membership in the workspace. */
export async function actor(t: TestApp, workspaceId: string, principal: { id: string; displayName?: string }) {
  const ctx = await t.tenancy!.context(workspaceId, principal.id);
  if (!ctx) throw new Error(`${principal.id} is not a member of ${workspaceId}`);
  return { ...ctx, principalId: principal.id, ...(principal.displayName ? { displayName: principal.displayName } : {}) };
}

/** Invite `who` into the workspace (as `by`) with a role, accept it, and enter the workspace (me:ensure). */
export async function joinAs(t: TestApp, workspaceId: string, by: typeof ADA, who: typeof GRACE, role: string) {
  const { token } = await t.tenancy!.invite(await actor(t, workspaceId, by), { email: `${who.id}@example.com`, role });
  await t.tenancy!.accept(token, who, { allowAnyAddress: true });
  const caller = t.as(who, { tenant: workspaceId });
  await caller.mutation(api.me.ensure, {});
  return caller;
}

/** Add the room agent to a workspace the FeltKit way (an agent identity, added directly), then agents:add (its profile). */
export async function addAgent(t: TestApp, workspaceId: string, by: { id: string; displayName?: string } = ADA) {
  await t.tenancy!.addPrincipal(await actor(t, workspaceId, by), AGENT, "agent");
  await t.as(by as any, { tenant: workspaceId }).mutation(api.agents.add, {});
}

/** Ada's workspace Acme with Grace invited as member, and Mallory in her own workspace (Evil Corp). */
export async function setup() {
  const t: TestApp = await createApp();
  const ws = (await t.tenancy!.create("Acme", ADA)).id;
  const ada = t.as(ADA, { tenant: ws });
  await ada.mutation(api.me.ensure, {});
  const grace = await joinAs(t, ws, ADA, GRACE, "member");
  const malloryWs = (await t.tenancy!.create("Evil Corp", MALLORY)).id;
  const mallory = t.as(MALLORY, { tenant: malloryWs });
  await mallory.mutation(api.me.ensure, {});
  const channels = await ada.query(api.channels.list, {});
  const general = channels.find((c: any) => c.name === "general")!.id;
  return { t, ada, grace, mallory, ws, general, malloryWs };
}

/** FeltKit's HTTP server on the test runtime, and signed-in bearer clients for dev users (the real tenancy routes). */
export async function serve(t: TestApp) {
  const { startServer } = await import("@feltdb/feltkit/server");
  const { createClient } = await import("@feltdb/feltkit/client");
  const server = await startServer({ runtime: t.runtime as any, projectDir: process.cwd(), port: 0, host: "127.0.0.1", dashboard: { enabled: false, adminToken: "", dir: null } });
  const signIn = async (id: string, workspaceId?: string) => {
    let token: string | null = null;
    const client = createClient({ url: server.url, tokens: { get: () => token, set: (v) => { token = v; } } });
    await client.signInAsDevUser(id);
    if (workspaceId) await client.switchTenant(workspaceId);
    return client;
  };
  const anonymous = createClient({ url: server.url, tokens: { get: () => null, set: () => undefined } });
  /** Share a file the FeltKit way: an upload link from the app, the bytes over HTTP, then attach. */
  const upload = async (caller: any, channelId: string, name: string, bytes: Uint8Array, contentType = "application/octet-stream") => {
    const link = await caller.mutation(api.attachments.uploadLink, { channelId, name, contentType });
    const file = await anonymous.uploadFile(link, bytes, { name, contentType });
    return { file, attachment: await caller.mutation(api.attachments.attach, { channelId, fileId: file.id }) };
  };
  /** Download through a link from attachments:download (no session: the link is the capability). */
  const download = async (link: { url: string }) => new Uint8Array(await (await fetch(anonymous.fileUrl(link))).arrayBuffer());
  return { url: server.url, signIn, upload, download, close: () => server.close() };
}

export async function rejects(p: Promise<unknown>, code: string | string[]) {
  try {
    await p;
  } catch (e: any) {
    const codes = Array.isArray(code) ? code : [code];
    if (!codes.includes(e?.code)) throw new Error(`expected ${codes.join("|")}, got ${e?.code}: ${e?.message}`);
    return e;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}
