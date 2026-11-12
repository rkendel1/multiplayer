/**
 * PersonalOS Anywhere, end to end, in real browsers against real services:
 *
 *   Multiplayer (feltkit dev) ──bridge session──▶ PersonalOS (feltkit dev)
 *                                                   ├─ Resolver   (@appport/resolver, real server): who
 *                                                   └─ AuthBoundry (real authority, built from source): whether
 *
 * Starts all four with fresh state, bootstraps AuthBoundry through its control API (application,
 * capability contract, principals, policies, a check credential) and Resolver (a least-privilege key for
 * PersonalOS), creates PersonalOS's bridge session for Multiplayer, then drives Multiplayer and PersonalOS
 * in Chromium as Ada and Grace. Writes screenshots and evidence.json.
 *
 *   PERSONALOS_DIR=../personalOS node e2e/personalos-anywhere.e2e.mjs
 *
 * AuthBoundry: the published @authboundry/core PersonalOS pins (`npm ci --prefix tests/authboundry`
 * in PersonalOS). Resolver: the published @appport/resolver PersonalOS pins (npm ci --prefix tests/resolver there).
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const POS_DIR = path.resolve(process.env.PERSONALOS_DIR ?? path.join(ROOT, "..", "personalOS"));
// The real AuthBoundry server: the published @authboundry/core PersonalOS pins in tests/authboundry
// (npm ci --prefix tests/authboundry there). Its native server is run directly (as PersonalOS's
// fixture does), with the package's own bridges and PersonalOS's authboundry.flow.
const AB_HOME = path.join(POS_DIR, "tests", "authboundry");
const AB_PKG = path.join(AB_HOME, "node_modules", "@authboundry", "core");
// The binary @authboundry/core bundles for this platform (see PersonalOS tests/fixtures/anywhere.ts: in 1.17.3
// three of the four @authboundry/core-<platform> packages carry the 1.16.0 binary). AUTHBOUNDRY_CLI_PATH: development only.
const AB_BIN = process.env.AUTHBOUNDRY_CLI_PATH ?? path.join(AB_PKG, "native", `${process.platform}-${process.arch}`, "authboundry");
const SHOTS = path.resolve(process.env.SHOTS ?? path.join(ROOT, "e2e", "screenshots", "anywhere"));
const PORTS = { resolver: 4310, authority: 4410, personalos: 3110, multiplayer: 3217 };
const MP = `http://localhost:${PORTS.multiplayer}`;
const POS = `http://localhost:${PORTS.personalos}`;
const INSTANCE = "multiplayer-e2e";
const ZONE = "Pacific/Auckland";
const studioTokens = {};
const EVENTS_SECRET = `whsec_e2e_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

const SECRETS = new Set();
/** Evidence and logs are committed: every secret this run created is replaced before anything is written. */
function scrub(text) {
  let out = String(text);
  for (const v of [EVENTS_SECRET, ...SECRETS, studioTokens.mp, studioTokens.pos]) if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[secret]");
  return out;
}
const writeEvidence = (evidence, results) => fs.writeFileSync(path.join(SHOTS, "evidence.json"), scrub(JSON.stringify({ ...evidence, results }, null, 2)));

const results = [];
const check = async (n, name, fn) => {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ n, name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) }); console.log(`ok   ${n}. ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ n, name, ok: false, ms: Date.now() - t0, error: String(e.message ?? e).split("\n")[0] }); console.log(`FAIL ${n}. ${name}: ${e.message}`); }
};
const children = [];
const logs = {};
function start(name, cmd, args, { cwd, env = {}, ready }) {
  logs[name] = "";
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const on = (d) => { logs[name] += String(d); };
  child.stdout.on("data", on);
  child.stderr.on("data", on);
  children.push(child);
  return waitFor(ready, name);
}
const stopAll = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } };
async function waitFor(url, name, timeout = 90000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not yet */ }
    if (Date.now() - t0 > timeout) throw new Error(`${name} did not come up: ${logs[name]?.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
const until = async (fn, what, timeout = 20000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 300)); }
};

// ── The stack ───────────────────────────────────────────────────────────────

async function startResolver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anywhere-resolver-"));
  const cli = path.join(POS_DIR, "tests", "resolver", "node_modules", "@appport", "resolver", "dist", "cli.js");
  const init = execFileSync(process.execPath, [cli, "init", "--dir", dir, "--tenant", "personalos"], { encoding: "utf8" });
  const adminKey = init.split(/\s+/).find((w) => w.startsWith("app_live_"));
  await start("resolver", process.execPath, [cli, "serve", "--dir", dir, "--port", String(PORTS.resolver), "--host", "127.0.0.1"], { ready: `http://127.0.0.1:${PORTS.resolver}/.well-known/appport` });
  const { ResolverClient } = await import(path.join(POS_DIR, "node_modules", "@appport", "resolver-client", "dist", "index.js"));
  const admin = await ResolverClient.connect({ url: `http://127.0.0.1:${PORTS.resolver}`, apiKey: adminKey, live: false, maxStaleSeconds: 0 });
  // PersonalOS's two keys (feltkit/_resolver.ts there): one that can only read identity links, one that can only write them.
  const read = await admin.createKey("personalos-resolve");
  await admin.grant(read.principal, ["read"], "ref://identity/personalos/*");
  const write = await admin.createKey("personalos-link");
  await admin.grant(write.principal, ["write"], "ref://identity/personalos/*");
  SECRETS.add(adminKey); SECRETS.add(read.secret); SECRETS.add(write.secret);
  return { admin, readKey: read.secret, writeKey: write.secret };
}

const CAPABILITIES = ["personalos.assistant.converse", "personalos.conversation.read", "personalos.tasks.read", "personalos.tasks.create", "personalos.tasks.update", "personalos.tasks.delete", "personalos.reminders.create", "personalos.memory.read", "personalos.memory.write", "personalos.memory.delete", "personalos.projects.create"];

async function startAuthority() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "anywhere-authboundry-"));
  const grants = ["identity.read", "identity.write", "principal.read", "principal.write", "policy.read", "policy.write", "agent.read", "agent.write", "delegation.read", "delegation.create", "delegation.revoke", "audit.read", "evidence.read", "authorization.read", "authorization.explain", "session.admin"].flatMap((g) => ["--grant", `authority.${g}=role:owner`]);
  const env = { AUTHBOUNDRY_PORTAL_ORIGIN: "http://localhost:3001", AUTHBOUNDRY_FELTDB_PATH: data, AUTHBOUNDRY_FELTDB_BRIDGE: path.join(AB_PKG, "bridge", "feltdb-store.cjs"), AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE: path.join(AB_PKG, "bridge", "appport-services.cjs"), AUTHBOUNDRY_NODE: process.execPath, FELTDB_URL: "", FELTDB_ENDPOINT: "" };
  if (!AB_BIN) throw new Error(`AuthBoundry is not installed: npm ci --prefix ${AB_HOME}`);
  await start("authority", AB_BIN, ["serve", path.join(AB_HOME, "authboundry.flow"), "--addr", `127.0.0.1:${PORTS.authority}`, "--tenant", "reference", "--account", "owner:local-password:role=owner@reference", ...grants], { cwd: data, env, ready: `http://127.0.0.1:${PORTS.authority}/health` });
  const base = `http://127.0.0.1:${PORTS.authority}`;
  const req = async (p, { method = "GET", credential, body } = {}) => {
    const url = new URL(p, base); url.searchParams.set("tenant", "reference");
    const r = await fetch(url, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(credential ? { "x-authboundry-session": credential } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const v = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(v)}`);
    return v;
  };
  const { credential } = await req("/_authboundry/browser/credentials", { method: "POST", body: { application: "portal", connector: "local", tenant: "reference", return_to: "/", username: "owner", password: "local-password" } });
  await req("/_authboundry/control-plane/organizations", { method: "POST", credential, body: { id: "personalos", name: "PersonalOS", authority_tenant_id: "reference" } });
  await req("/_authboundry/control-plane/applications", { method: "POST", credential, body: { id: "personalos", project_id: "personalos", name: "PersonalOS", production_url: POS, environment: "production" } });
  await req("/_authboundry/control-plane/applications/personalos/contracts", { method: "POST", credential, body: { authority_source: "external", version: "1.0.0", capabilities: CAPABILITIES } });
  const policy = async (owner, capabilities) => {
    await req("/_authboundry/control-plane/applications/personalos/principals", { method: "POST", credential, body: { id: `user:${owner}`, kind: "human", claims: { role: "owner" } } }).catch(() => undefined);
    await req("/_authboundry/policies", { method: "POST", credential, body: { application: "personalos", principal_id: `user:${owner}`, capabilities } });
  };
  // People hold their own capabilities; PersonalOS's executor holds none of its own.
  await policy("ada", CAPABILITIES);
  await policy("grace", CAPABILITIES);
  await req("/_authboundry/agents", { method: "POST", credential, body: { id: "agent:personalos", name: "PersonalOS", application: "personalos" } });
  // What PersonalOS may do for each person is that person's delegation to it (administration here:
  // AuthBoundry has no federated sign-in for PersonalOS accounts yet, see the M3 register).
  const delegate = (id, owner, caps) => req("/_authboundry/delegations", { method: "POST", credential, body: { id, delegator: `user:${owner}`, delegate: "agent:personalos", capabilities: caps.join(","), application: "personalos" } });
  await delegate("ada-personalos", "ada", CAPABILITIES);
  // Grace delegated reading and conversing, not task creation.
  await delegate("grace-personalos", "grace", CAPABILITIES.filter((c) => c !== "personalos.tasks.create"));
  const { secret } = await req("/_authboundry/control-plane/applications/personalos/check-credentials", { method: "POST", credential, body: { label: "personalos e2e" } });
  SECRETS.add(secret); SECRETS.add(credential);
  return { url: base, checkCredential: secret, delegate, revokeDelegation: (id) => req(`/_authboundry/delegations/${id}/revoke`, { method: "POST", credential, body: {} }) };
}

/** A FeltKit client in Node, signed in as a development user (for reading back evidence). */
async function devClient(dir, url, user, extra = {}) {
  const { createClient } = await import(path.join(dir, "node_modules", "@feltdb", "feltkit", "dist", "client", "index.js"));
  let token = null;
  const client = createClient({ url, tokens: { get: () => token, set: (v) => { token = v; } }, ...extra });
  await client.signInAsDevUser(user);
  return client;
}
const ref = (name) => ({ name, kind: "query" });

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const evidence = { started: new Date().toISOString(), authboundry: { package: "@authboundry/core", version: fs.existsSync(AB_PKG) ? JSON.parse(fs.readFileSync(path.join(AB_PKG, "package.json"), "utf8")).version : null, binary: path.relative(POS_DIR, AB_BIN), sha256: fs.existsSync(AB_BIN) ? createHash("sha256").update(fs.readFileSync(AB_BIN)).digest("hex") : null, ...(process.env.AUTHBOUNDRY_CLI_PATH ? { binaryOverride: "AUTHBOUNDRY_CLI_PATH (development only: not the published binary)" } : {}) } };
  let resolver, authority, bridgeToken;
  try {
    resolver = await startResolver();
    authority = await startAuthority();
    const posState = fs.mkdtempSync(path.join(os.tmpdir(), "anywhere-pos-"));
    await start("personalos", "npx", ["feltkit", "dev", "--port", String(PORTS.personalos)], {
      cwd: POS_DIR,
      // Credentials as custody references (FELTKIT_CREDENTIAL_<ID>): the check credential and the signing
      // secret of interaction.updated; the app code never reads either.
      env: { FELTKIT_STATE_DIR: posState, RESOLVER_URL: `http://127.0.0.1:${PORTS.resolver}`, FELTKIT_CREDENTIAL_RESOLVER_RESOLVE: resolver.readKey, FELTKIT_CREDENTIAL_RESOLVER_LINK: resolver.writeKey, AUTHBOUNDRY_URL: authority.url, FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK: authority.checkCredential, FELTKIT_CREDENTIAL_SURFACE_EVENTS: EVENTS_SECRET },
      ready: `${POS}/api/session`,
    });
    const out = execFileSync("npx", ["feltkit", "session", "create", "--id", "multiplayer", "--role", "bridge", "--type", "service", "--label", "Multiplayer bridge (e2e)"], { cwd: POS_DIR, env: { ...process.env, FELTKIT_STATE_DIR: posState }, encoding: "utf8" });
    bridgeToken = out.split(/\s+/).find((w) => /^fks_/.test(w));
    SECRETS.add(bridgeToken);
    if (!bridgeToken) throw new Error("feltkit session create printed no token");
    const mpState = fs.mkdtempSync(path.join(os.tmpdir(), "anywhere-mp-"));
    await start("multiplayer", "npx", ["feltkit", "dev", "--port", String(PORTS.multiplayer)], {
      cwd: ROOT, env: { FELTKIT_STATE_DIR: mpState, PERSONALOS_URL: POS, FELTKIT_CREDENTIAL_PERSONALOS_BRIDGE: bridgeToken, FELTKIT_CREDENTIAL_PERSONALOS_EVENTS: EVENTS_SECRET, MULTIPLAYER_INSTANCE: INSTANCE }, ready: `${MP}/api/session`,
    });
    // Events: Multiplayer accepts PersonalOS as an inbound integration; PersonalOS sends interaction.updated
    // there, signed with the same secret. Both registered by an operator through Studio's admin API.
    const studio = (log) => /Dashboard\s+(\S+)#token=(fka_[A-Za-z0-9_-]+)/.exec(log)?.[2];
    const admin = async (base, token, asUser, route, body) => {
      const r = await fetch(`${base}/_feltkit/api${route}`, { method: "POST", headers: { "content-type": "application/json", "x-feltkit-admin": token, "x-feltkit-as": asUser }, body: JSON.stringify(body) });
      const v = await r.json().catch(() => ({}));
      if (r.status >= 400) throw new Error(`${route}: ${r.status} ${JSON.stringify(v)}`);
      return v.item ?? v;
    };
    const mpToken = await until(() => studio(logs.multiplayer), "Multiplayer Studio token");
    const posToken = await until(() => studio(logs.personalos), "PersonalOS Studio token");
    studioTokens.mp = mpToken; studioTokens.pos = posToken;
    const integration = await admin(MP, mpToken, "ada", "/services/webhooks/integrations", { provider: "personalos", signingCredentialRef: "credential-ref:personalos-events" });
    const endpoint = await admin(POS, posToken, "ada", "/services/manage/_appport/webhooks", { url: `${MP}/webhooks/inbound/${integration.id}`, events: ["interaction.updated"], signingCredentialRef: "credential-ref:surface-events" });
    evidence.events = { integration: { id: integration.id, principal: integration.principalId }, endpoint: { id: endpoint.id, url: endpoint.url, events: endpoint.events } };
  } catch (e) {
    console.log(`ENVIRONMENT: the stack could not start: ${e.message}`);
    evidence.environment = String(e.message);
    writeEvidence(evidence, results);
    stopAll();
    process.exit(2);
  }

  const browser = await chromium.launch();
  const mk = async (who, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...opts });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${who}] pageerror ${e}`));
    return page;
  };
  let ada = await mk("ada-multiplayer", { timezoneId: ZONE });
  let reopenAda = async () => undefined;
  const grace = await mk("grace-multiplayer");
  const adaPos = await mk("ada-personalos");
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });
  const posAda = await devClient(POS_DIR, POS, "ada");
  const posGrace = await devClient(POS_DIR, POS, "grace");
  const tasksOf = (c) => c.query(ref("tasks:list"), {});
  const box = (page, name = "Message #general") => page.getByRole("textbox", { name });
  const say = async (page, text, name) => { await box(page, name).fill(text); await box(page, name).press("Enter"); };
  /** The PersonalOS reply to a message: in the message's thread. */
  const threadReply = async (page, stamp, pattern, timeout = 25000, shotName = null) => {
    const msg = page.locator('[data-testid="message"]', { hasText: stamp }).first();
    await msg.getByRole("button", { name: /repl(y|ies)/ }).waitFor({ timeout });
    await msg.getByRole("button", { name: /repl(y|ies)/ }).click();
    const reply = page.locator(".thread, aside").getByText(pattern).first();
    await reply.waitFor({ timeout });
    const text = await reply.innerText();
    if (shotName) await shot(page, shotName);
    await page.getByRole("button", { name: "Close panel" }).click();
    return text;
  };
  const stamp = Date.now().toString(36);

  // ── Setup through the products' own UIs ─────────────────────────────────
  await check(0, "setup: Ada opens a workspace in Multiplayer and adds @personalos; Grace joins it", async () => {
    await ada.goto(`${MP}/?as=ada`);
    await ada.getByRole("button", { name: "Open sample workspace" }).click();
    await ada.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 20000 });
    await ada.getByRole("button", { name: "✦ Add @personalos" }).click();
    await ada.getByText(/@personalos joined/).waitFor();
    // Grace: invited by e-mail and signed in with an e-mailed code, as in Multiplayer's own e2e. In
    // Multiplayer she is the account grace@example.com; in PersonalOS the development user "grace".
    const mail = async (subject, since) => until(() => { const text = logs.multiplayer.slice(since); const at = text.lastIndexOf("✉ grace@example.com: "); return at >= 0 && subject.test(text.slice(at, text.indexOf("\n", at))) ? text.slice(at, at + 2000) : null; }, `e-mail ${subject}`);
    await ada.getByRole("button", { name: "＋ Invite people" }).click();
    await ada.getByLabel("E-mail").fill("grace@example.com");
    await ada.getByLabel("Role").selectOption("member");
    await ada.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await ada.getByLabel("Invitation link").inputValue();
    await ada.getByRole("button", { name: "Close" }).click();
    await grace.goto(link);
    await grace.getByRole("button", { name: "E-mail me a sign-in link" }).first().click();
    const since = logs.multiplayer.length;
    await grace.getByRole("button", { name: "E-mail me a sign-in link" }).click();
    const code = /Or enter this code: (\d{4} \d{4})/.exec(await mail(/Sign in to/, since))[1];
    await grace.getByLabel("Code").fill(code);
    await grace.getByRole("button", { name: "Sign in" }).click();
    await grace.getByRole("button", { name: /^Join / }).click();
    await grace.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 20000 });
    await shot(ada, "00-multiplayer-personalos-added.png");
  });

  await check(13, "an unknown (unlinked) identity cannot act: Grace's mention is refused with how to connect", async () => {
    await say(grace, `@personalos add buy flowers to my list (${stamp}-g0)`);
    const text = await threadReply(grace, `${stamp}-g0`, /don't know which PersonalOS account is yours/);
    if ((await tasksOf(posGrace)).length) throw new Error("a task was created for an unlinked sender");
    return { reply: text.slice(0, 120) };
  });

  await check(3, "linking (proof of both identities): a code issued in PersonalOS, sent by Ada in a DM in Multiplayer, confirmed by Ada in PersonalOS; Resolver records it", async () => {
    await adaPos.goto(`${POS}/#/settings`);
    await adaPos.getByRole("button", { name: "Connect Multiplayer" }).click();
    const code = (await adaPos.getByTestId("link-code").innerText()).match(/link ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
    await shot(adaPos, "01-personalos-link-code.png");
    await ada.getByRole("button", { name: "New message" }).click();
    await ada.getByLabel("Find people").fill("personalos");
    await ada.getByRole("checkbox").first().check();
    await ada.getByRole("button", { name: "Open direct message" }).click();
    await say(ada, `link ${code}`, "Message PersonalOS");
    await ada.getByText(/^Almost connected\. Open PersonalOS/).waitFor({ timeout: 20000 });
    // Nothing is linked until Ada, signed in to PersonalOS, confirms the account that sent the code.
    if ((await resolver.admin.list("ref://identity/personalos/multiplayer/")).refs.some((r) => r.state === "active")) throw new Error("linked before the owner confirmed");
    await adaPos.reload();
    const presented = adaPos.getByTestId("link-presented");
    await presented.getByText(/\(ada\)/).waitFor();
    await shot(adaPos, "01a-personalos-confirm-link.png");
    await presented.getByRole("button", { name: "This is me" }).click();
    await until(async () => (await resolver.admin.list("ref://identity/personalos/multiplayer/")).refs.some((r) => r.state === "active"), "the identity agent recorded the link");
    const { refs } = await resolver.admin.list("ref://identity/personalos/multiplayer/");
    const active = refs.filter((r) => r.state === "active");
    const value = (await resolver.admin.resolve(active[0].ref)).selected.value;
    if (active.length !== 1 || value.canonical !== "personalos:account:ada" || value.external.principalId !== "ada" || value.external.instance !== INSTANCE) throw new Error(`unexpected Resolver state: ${JSON.stringify(value)}`);
    await adaPos.reload();
    await adaPos.getByTestId("connected-surfaces").getByText(/as Ada Lovelace/).waitFor();
    await shot(ada, "02-multiplayer-linked-dm.png");
    evidence.resolverLink = { ref: active[0].ref, value, history: await resolver.admin.history(active[0].ref) };
    return { ref: active[0].ref };
  });

  // Grace links too (for isolation checks).
  const linkGrace = async () => {
    const { code } = await posGrace.mutation({ name: "links:start", kind: "mutation" }, { adapter: "multiplayer" });
    await grace.getByRole("button", { name: "New message" }).click();
    await grace.getByLabel("Find people").fill("personalos");
    await grace.getByRole("checkbox").first().check();
    await grace.getByRole("button", { name: "Open direct message" }).click();
    await say(grace, `link ${code}`, "Message PersonalOS");
    await grace.getByText(/^Almost connected\./).waitFor({ timeout: 20000 });
    const [presented] = (await posGrace.query({ name: "links:list", kind: "query" }, {})).filter((l) => l.status === "presented");
    await posGrace.mutation({ name: "links:confirm", kind: "mutation" }, { id: presented.id });
    await until(async () => (await posGrace.query({ name: "links:list", kind: "query" }, {})).some((l) => l.status === "active"), "Grace's link recorded");
    await grace.getByRole("button", { name: /^#\s*general/ }).click();
  };

  let reminderMessage = "";
  await check(1, "1-2, 4-8, 17: Ada mentions @PersonalOS in #general: verified, resolved, authorized; a real reminder at Ada's local 9:00 tomorrow; the result in the thread", async () => {
    await ada.getByRole("button", { name: /^#\s*general/ }).click();
    await say(ada, `@PersonalOS remind me to follow up with Sarah tomorrow at 9am (${stamp}-r1)`);
    const text = await threadReply(ada, `${stamp}-r1`, /remind you to/, 25000, "03a-multiplayer-reminder-thread.png");
    const task = (await tasksOf(posAda)).find((x) => x.title.includes("Follow up with Sarah"));
    if (!task) throw new Error("no task in PersonalOS");
    // Timezone: "tomorrow at 9am" in Ada's zone (Pacific/Auckland), not the server's.
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(task.remindAt));
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400000));
    if (!local.startsWith(tomorrow) || !local.endsWith("09:00")) throw new Error(`reminder at ${local} ${ZONE}, expected ${tomorrow} 09:00`);
    const i = (await posAda.query(ref("interactions:list"), { limit: 10 })).find((x) => x.text.includes(`${stamp}-r1`));
    // Resolver resolved the authenticated sender; AuthBoundry allowed this exact capability, with a decision id.
    if (i.identity.canonical !== "personalos:account:ada" || !i.identity.resolverRef?.startsWith("ref://identity/personalos/multiplayer/")) throw new Error(`identity: ${JSON.stringify(i.identity)}`);
    // Requester, executor and delegation are distinct: PersonalOS's agent acted on behalf of Ada, under
    // Ada's delegation to it, decided by the real AuthBoundry (its own decision id).
    if (i.authority?.outcome !== "allow" || i.authority.capability !== "personalos.reminders.create" || i.authority.principal !== "agent:personalos" || i.authority.onBehalfOf !== "user:ada" || i.authority.delegationId !== "ada-personalos" || !/decision/.test(i.authority.decisionId ?? "")) throw new Error(`authority: ${JSON.stringify(i.authority)}`);
    const actions = await posAda.query(ref("actions:list"), {});
    const evidenceAction = actions.find((a) => a.kind === "reminder.create" && a.evidence?.id === task.id);
    if (!evidenceAction?.evidence?.verified) throw new Error("no verified execution evidence");
    evidence.reminder = { reply: text, task: { id: task.id, title: task.title, due: task.due, remindAt: task.remindAt, localInZone: local }, action: evidenceAction, interaction: i };
    reminderMessage = `${stamp}-r1`;
    return { local, zone: ZONE };
  });

  await check(5, "PersonalOS received bounded, provenance-carrying context and the decision evidence (interaction record)", async () => {
    const all = await posAda.query(ref("interactions:list"), { limit: 10 });
    const i = all.find((x) => x.text.includes(`${stamp}-r1`));
    if (!i || i.surface !== "Multiplayer" || i.where !== "Multiplayer · #general" || !i.context || i.context.messages < 1) throw new Error(JSON.stringify(i));
    return { context: i.context, provenance: i.provenance };
  });

  await check(8, "the same interaction is visible in PersonalOS: the conversation, the task, the action log", async () => {
    await adaPos.goto(`${POS}/#/tasks`);
    await adaPos.getByText("Follow up with Sarah").waitFor();
    await shot(adaPos, "03-personalos-task.png");
    await adaPos.goto(`${POS}/#/settings`);
    await adaPos.getByText(new RegExp(`Multiplayer · #general:.*${stamp}-r1`)).waitFor();
    await shot(adaPos, "04-personalos-recent-requests.png");
  });

  await check(9, "an ambiguous request triggers clarification in the thread", async () => {
    await say(ada, `@personalos remind me to email Omar (${stamp}-c1)`);
    const text = await threadReply(ada, `${stamp}-c1`, /When should I remind you/);
    return { reply: text };
  });

  await check(10, "approval required: the request waits for Ada's approval in PersonalOS; approved there, the result is posted back in the thread", async () => {
    await say(ada, `@personalos delete follow up with sarah (${stamp}-a1)`);
    await ada.getByText("✦ PersonalOS is waiting for approval in PersonalOS").waitFor({ timeout: 20000 });
    await shot(ada, "05-multiplayer-awaiting-approval.png");
    if (!(await tasksOf(posAda)).some((x) => x.title.includes("Follow up with Sarah"))) throw new Error("deleted before approval");
    await adaPos.goto(`${POS}/#/activity`);
    await adaPos.getByRole("button", { name: "Approve" }).first().click();
    await until(async () => !(await tasksOf(posAda)).some((x) => x.title.includes("Follow up with Sarah")), "task deleted after approval");
    const text = await threadReply(ada, `${stamp}-a1`, /Approved in PersonalOS and done/, 30000, "06a-multiplayer-approved-thread.png");
    await shot(ada, "06-multiplayer-approved.png");
    return { reply: text };
  });

  await check(11, "a denied action does not execute, and the denial is reflected in the thread", async () => {
    await posAda.mutation({ name: "tasks:create", kind: "mutation" }, { title: `Keep this ${stamp}` });
    await say(ada, `@personalos delete keep this ${stamp} (${stamp}-d1)`);
    await ada.getByText("✦ PersonalOS is waiting for approval in PersonalOS").waitFor({ timeout: 20000 });
    await adaPos.goto(`${POS}/#/activity`);
    await adaPos.getByRole("button", { name: /Reject|Decline/ }).first().click();
    const text = await threadReply(ada, `${stamp}-d1`, /Declined in PersonalOS\. Nothing was changed/, 30000);
    if (!(await tasksOf(posAda)).some((x) => x.title === `Keep this ${stamp}`)) throw new Error("denied action executed");
    return { reply: text };
  });

  await check(16, "cancellation by the requester is reflected accurately (and the proposal is declined in PersonalOS)", async () => {
    await say(ada, `@personalos delete keep this ${stamp} (${stamp}-x1)`);
    await ada.getByText("✦ PersonalOS is waiting for approval in PersonalOS").waitFor({ timeout: 20000 });
    await ada.locator('.personalos-state[data-phase="awaiting_approval"]').getByRole("button", { name: "Cancel" }).click();
    const text = await threadReply(ada, `${stamp}-x1`, /Cancelled\. Nothing was changed/, 30000);
    const proposed = (await posAda.query(ref("actions:list"), { status: "proposed" })).length;
    if (proposed) throw new Error(`${proposed} proposal(s) still pending`);
    return { reply: text };
  });

  await check(3.3, "PHASE 3: approval decided in PersonalOS reaches a CLOSED Multiplayer conversation by a signed event; reopened, the result is there; a replayed delivery changes nothing", async () => {
    const before = (await tasksOf(posAda)).length;
    await posAda.mutation({ name: "tasks:create", kind: "mutation" }, { title: `Event check ${stamp}` });
    await ada.getByRole("button", { name: /^#\s*general/ }).click();
    await say(ada, `@personalos delete event check ${stamp} (${stamp}-e1)`);
    await ada.getByText("✦ PersonalOS is waiting for approval in PersonalOS").waitFor({ timeout: 20000 });
    // Nobody has Multiplayer open from here on.
    const adaContext = ada.context();
    await ada.close();
    reopenAda = async () => { if (ada.isClosed()) { ada = await adaContext.newPage(); await ada.goto(`${MP}/`); await ada.getByRole("button", { name: /^#\s*general/ }).click(); } };
    await adaPos.goto(`${POS}/#/activity`);
    await adaPos.getByRole("button", { name: "Approve" }).first().click();
    // The result is posted in the thread by PersonalOS's event, with no browser on Multiplayer.
    const mp = await devClient(ROOT, MP, "ada");
    const ws = (await mp.tenants()).tenants[0];
    await mp.switchTenant(ws.id);
    const general = (await mp.query(ref("channels:list"), {})).find((c) => c.name === "general");
    const request = (await mp.query(ref("messages:list"), { channelId: general.id })).items.find((m) => m.text.includes(`${stamp}-e1`));
    const replies = async () => (await mp.query(ref("messages:thread"), { rootId: request.id })).replies.map((r) => r.text);
    await until(async () => (await replies()).includes("Approved in PersonalOS and done."), "result posted while the conversation was closed", 30000);
    const delivered = await replies();
    // Reopen: the result is there.
    ada = await adaContext.newPage();
    await ada.goto(`${MP}/`);
    await ada.getByRole("button", { name: /^#\s*general/ }).click();
    const text = await threadReply(ada, `${stamp}-e1`, /Approved in PersonalOS and done/, 20000, "09-multiplayer-result-after-closed.png");
    // Replay: the same signed event id is refused; a fresh delivery of the same update posts nothing new.
    const event = { type: "interaction.updated", data: { adapter: "multiplayer", instance: INSTANCE, key: `${INSTANCE}:${request.id}`, workspaceId: ws.id, seq: 2, state: "completed" } };
    const send = async (eventId) => {
      const raw = JSON.stringify(event);
      const timestamp = new Date().toISOString();
      const { createHmac } = await import("node:crypto");
      const signature = createHmac("sha256", EVENTS_SECRET).update(`${timestamp}.${raw}`).digest("hex");
      return (await fetch(`${MP}/webhooks/inbound/${evidence.events.integration.id}`, { method: "POST", headers: { "content-type": "application/json", "x-appport-event-id": eventId, "x-appport-timestamp": timestamp, "x-appport-signature": signature }, body: raw })).status;
    };
    const first = await send(`replay-${stamp}`);
    const replayed = await send(`replay-${stamp}`);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await replies();
    if (replayed !== 409) throw new Error(`replayed event answered ${replayed}`);
    if (after.length !== delivered.length) throw new Error(`a replay posted again: ${JSON.stringify(after)}`);
    const approvals = (await posAda.query(ref("actions:list"), {})).filter((a) => a.kind === "task.delete" && a.status === "succeeded" && a.input.title === `Event check ${stamp}`);
    if (approvals.length !== 1) throw new Error(`the action ran ${approvals.length} times`);
    if ((await tasksOf(posAda)).length !== before) throw new Error("task count changed unexpectedly");
    return { reply: text, firstStatus: first, replayStatus: replayed, threadReplies: after.length };
  });

  await reopenAda();
  await check(12, "an event replay does not duplicate execution (the bridge re-delivers the reminder's key)", async () => {
    const before = (await tasksOf(posAda)).length;
    const mp = await devClient(ROOT, MP, "ada");
    const ws = (await mp.tenants()).tenants[0];
    await mp.switchTenant(ws.id);
    const general = (await mp.query(ref("channels:list"), {})).find((c) => c.name === "general");
    const msg = (await mp.query(ref("messages:list"), { channelId: general.id })).items.find((m) => m.text.includes(reminderMessage));
    const stored = (await posAda.query(ref("interactions:list"), { limit: 50 })).find((x) => x.text.includes(reminderMessage));
    const bridge = bridgeToken;
    // Same key, even with different text: answered from the record, never executed again.
    const envelope = { contract: "personalos.interaction/1", source: { adapter: "multiplayer", instance: INSTANCE, eventId: msg.id, sequence: msg.seq, receivedAt: msg.createdAt }, sender: { sourcePrincipalId: "ada", displayName: "Ada Lovelace" }, conversation: { workspaceId: ws.id, conversationId: general.id, kind: "public", name: "general", participantCount: 3, directWithAssistant: false }, message: { id: msg.id, text: "@personalos add replayed task to my list", mentions: { assistant: true, handles: ["personalos"] }, attachments: [] }, context: { scope: "none", messages: [], limits: { maxMessages: 0, maxChars: 0, truncated: false } }, respondTo: { conversationId: general.id }, idempotencyKey: `${INSTANCE}:${msg.id}` };
    const r = await (await fetch(`${POS}/api/mutation/interactions:receive`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bridge}` }, body: JSON.stringify({ args: { envelope } }) })).json();
    if (!r.ok || !r.value.replayed || r.value.interactionId !== stored.id) throw new Error(JSON.stringify(r));
    if ((await tasksOf(posAda)).length !== before) throw new Error("replay executed");
    return { interactionId: r.value.interactionId };
  });

  await check(14, "another user's mention cannot reach Ada's private memory; AuthBoundry decides Grace's own capabilities", async () => {
    await posAda.mutation({ name: "memory:add", kind: "mutation" }, { kind: "person", subject: "sam", content: "Sam is my manager and is on medical leave" });
    await linkGrace();
    await say(grace, `@personalos what do you know about Sam? (${stamp}-g1)`);
    const text = await threadReply(grace, `${stamp}-g1`, /private PersonalOS data|don't have anything|answered in PersonalOS/, 25000, "08-multiplayer-grace-isolated.png");
    if (/medical|manager/.test(text)) throw new Error(`leak: ${text}`);
    await say(grace, `@personalos add steal ada's list to my list (${stamp}-g2)`);
    const denied = await threadReply(grace, `${stamp}-g2`, /aren't allowed to do that through Multiplayer \(personalos\.tasks\.create/);
    if ((await tasksOf(posGrace)).length) throw new Error("AuthBoundry denial executed");
    return { graceReply: text, denied };
  });

  await check(15, "a group conversation cannot expose Ada's private account data (her own mention in #general)", async () => {
    await say(ada, `@personalos what do you know about Sam? (${stamp}-p1)`);
    const text = await threadReply(ada, `${stamp}-p1`, /private PersonalOS data/, 25000, "07a-multiplayer-private-withheld-thread.png");
    if (/medical|manager/.test(text)) throw new Error(`leak: ${text}`);
    // The full answer exists only in Ada's PersonalOS.
    const conv = (await posAda.query(ref("conversations:list"), {})).find((c) => c.title === "Multiplayer · #general");
    const msgs = await posAda.query(ref("conversations:messagesOf"), { conversationId: conv.id });
    if (!msgs.some((m) => /medical leave/.test(m.text))) throw new Error("full answer not in PersonalOS");
    await shot(ada, "07-multiplayer-private-withheld.png");
    return { reply: text };
  });

  await check(4.2, "Ada's delegation revoked in AuthBoundry: the requester, executor and link are unchanged, and her next operation is refused", async () => {
    await authority.revokeDelegation("ada-personalos");
    await say(ada, `@personalos add after delegation revoke to my list (${stamp}-dr)`);
    const text = await threadReply(ada, `${stamp}-dr`, /aren't allowed to do that through Multiplayer/);
    if ((await tasksOf(posAda)).some((x) => /after delegation revoke/i.test(x.title))) throw new Error("executed after revocation");
    const i = (await posAda.query(ref("interactions:list"), { limit: 50 })).find((x) => x.text.includes(`${stamp}-dr`));
    if (i.authority.outcome !== "deny" || i.authority.onBehalfOf !== "user:ada" || i.authority.principal !== "agent:personalos") throw new Error(JSON.stringify(i.authority));
    await authority.delegate("ada-personalos-2", "ada", CAPABILITIES);
    return { reply: text, authority: i.authority };
  });

  await check(13.1, "a revoked identity cannot act: Ada disconnects in PersonalOS; the next mention is refused, and Resolver shows the link revoked", async () => {
    await adaPos.goto(`${POS}/#/settings`);
    await adaPos.getByTestId("connected-surfaces").getByRole("button", { name: "Disconnect" }).click();
    await say(ada, `@personalos add after revoke to my list (${stamp}-v1)`);
    // Refused at once: "disconnected" while the identity agent revokes it in Resolver, "don't know" after.
    await threadReply(ada, `${stamp}-v1`, /was disconnected from PersonalOS|don't know which PersonalOS account is yours/);
    if ((await tasksOf(posAda)).some((x) => /after revoke/i.test(x.title))) throw new Error("revoked identity acted");
    const states = await until(async () => { const st = (await resolver.admin.list("ref://identity/personalos/multiplayer/")).refs.map((r) => r.state); return st.includes("revoked") && st; }, "Resolver shows the link revoked");
    return { resolverStates: states };
  });

  await check(4.1, "Grace's delegation revoked in AuthBoundry: her next request is refused by the authority", async () => {
    await authority.revokeDelegation("grace-personalos");
    await say(grace, `@personalos what am I forgetting? (${stamp}-g3)`);
    await threadReply(grace, `${stamp}-g3`, /aren't allowed to do that through Multiplayer/);
  });

  for (const [name, text] of Object.entries(logs)) fs.writeFileSync(path.join(SHOTS, `log-${name}.txt`), scrub(text));
  // Diagnostics: PersonalOS's webhook deliveries and Multiplayer's inbound handling, from the apps themselves.
  try {
    const get = async (base, token, route) => (await fetch(`${base}/_feltkit/api${route}`, { headers: { "x-feltkit-admin": token, "x-feltkit-as": "ada" } })).json().catch(() => null);
    evidence.diagnostics = {
      personalosDeliveries: await get(POS, studioTokens.pos, "/services/manage/_appport/webhooks/deliveries"),
      personalosEndpoints: await get(POS, studioTokens.pos, "/services/manage/_appport/webhooks"),
      multiplayerActivity: ((await get(MP, studioTokens.mp, "/activity?limit=400"))?.entries ?? (await get(MP, studioTokens.mp, "/activity?limit=400")) ?? []),
    };
  } catch (e) { evidence.diagnostics = { error: String(e) }; }
  evidence.finished = new Date().toISOString();
  writeEvidence(evidence, results);
  await browser.close();
  stopAll();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); stopAll(); process.exit(1); });
