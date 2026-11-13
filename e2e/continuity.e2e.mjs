/**
 * PersonalOS M4.3, cross-surface continuity, end to end on the real stack:
 *
 *   PERSONALOS_DIR=../personalOS node e2e/continuity.e2e.mjs
 *
 * Real: Resolver and AuthBoundry (the published packages PersonalOS pins), PersonalOS and Multiplayer
 * (`feltkit dev`, fresh state), the Multiplayer → PersonalOS bridge, Chromium driving Multiplayer as Ada
 * and Grace, and a second Chromium with the PersonalOS extension loaded unpacked as Ada's browser, on a
 * real web page. Durable jobs and storage are PersonalOS's own; PersonalOS is killed (SIGKILL) and
 * restarted while work runs. No model is configured: research assesses by the rules.
 *
 *   A  Multiplayer → Chrome → Multiplayer: a reminder made in a Multiplayer DM; the same conversation
 *      continued from Chrome (a page shared into it); back in Multiplayer, both parts are there.
 *   B  Chrome → Multiplayer → Chrome: research summoned from a page; Chrome closed; PersonalOS killed and
 *      restarted mid-work; the conversation continued in a Multiplayer DM; the result arrives; Chrome
 *      reopened shows the Multiplayer parts and continues it again.
 *   E  Isolation: Grace (linked, her own conversation and invocation) can't reach Ada's, and Ada can't
 *      reach Grace's, by id, from either surface.
 *   D  Authority: Ada's delegation revoked in AuthBoundry: continuing in Multiplayer is refused, and a
 *      Chrome share into the conversation is refused when it runs; both refusals are in its history.
 *
 * Test-only differences (outside product code): the extension's host permissions are in the manifest
 * copy, the side panel opens as a tab, the page selection is made by script.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const POS_DIR = path.resolve(process.env.PERSONALOS_DIR ?? path.join(ROOT, "..", "personalOS"));
const AB_HOME = path.join(POS_DIR, "tests", "authboundry");
const AB_PKG = path.join(AB_HOME, "node_modules", "@authboundry", "core");
const AB_BIN = process.env.AUTHBOUNDRY_CLI_PATH ?? path.join(AB_PKG, "native", `${process.platform}-${process.arch}`, "authboundry");
const SHOTS = path.resolve(process.env.SHOTS ?? path.join(ROOT, "e2e", "screenshots", "continuity"));
const PORTS = { resolver: 4311, authority: 4411, personalos: 3111, multiplayer: 3218 };
const MP = `http://localhost:${PORTS.multiplayer}`;
const POS = `http://localhost:${PORTS.personalos}`;
const INSTANCE = "multiplayer-continuity";
const PAGE = process.env.CONTINUITY_PAGE ?? "https://www.thoughtworks.com/";
// The capability contract is PersonalOS's own (feltkit/_authority.ts), read from its source so this never drifts.
const CAPABILITIES = [...fs.readFileSync(path.join(POS_DIR, "feltkit", "_authority.ts"), "utf8").split("export const CAPABILITIES")[1].matchAll(/"(personalos\.[a-z.]+)"/g)].map((m) => m[1]);

const SECRETS = new Set();
const scrub = (text) => { let out = String(text); for (const v of SECRETS) if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[secret]"); return out; };
const results = [];
const evidence = { started: new Date().toISOString(), page: PAGE, capabilities: CAPABILITIES };
const check = async (n, name, fn) => {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ n, name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) }); console.log(`ok   ${n}. ${name} (${Date.now() - t0} ms)`); }
  catch (e) {
    results.push({ n, name, ok: false, ms: Date.now() - t0, error: String(e.message ?? e).split("\n")[0] });
    console.log(`FAIL ${n}. ${name}: ${e.message}`);
    // What every open page showed when it failed.
    for (const [i, page] of (globalThis.__pages?.() ?? []).entries()) await page.screenshot({ path: path.join(SHOTS, `fail-${n}-${i}.png`) }).catch(() => {});
  }
};
const children = {};
const logs = {};
function start(name, cmd, args, { cwd, env = {}, ready }) {
  logs[name] = logs[name] ?? "";
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const on = (d) => { logs[name] += String(d); };
  child.stdout.on("data", on);
  child.stderr.on("data", on);
  children[name] = child;
  return waitFor(ready, name);
}
async function stop(name, signal = "SIGTERM", stateDir = null) {
  const child = children[name];
  if (!child) return;
  const exited = new Promise((r) => child.once("exit", r));
  try { process.kill(-child.pid, signal); } catch { /* gone */ }
  await exited;
  delete children[name];
  // npx exits before the server under it: wait until the process holding the state's lock is gone.
  if (stateDir) {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(path.join(stateDir, "owner.lock"), "utf8")).pid; } catch { /* none */ }
    for (let i = 0; holder && i < 100; i++) { try { process.kill(holder, 0); } catch { break; } try { process.kill(holder, signal); } catch { /* gone */ } await sleep(200); }
  }
}
const stopAll = () => { for (const c of Object.values(children)) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, name, timeout = 90000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not yet */ }
    if (Date.now() - t0 > timeout) throw new Error(`${name} did not come up: ${logs[name]?.slice(-800)}`);
    await sleep(400);
  }
}
const until = async (fn, what, timeout = 30000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`); await sleep(400); }
};

async function startResolver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-resolver-"));
  const cli = path.join(POS_DIR, "tests", "resolver", "node_modules", "@appport", "resolver", "dist", "cli.js");
  const init = execFileSync(process.execPath, [cli, "init", "--dir", dir, "--tenant", "personalos"], { encoding: "utf8" });
  const adminKey = init.split(/\s+/).find((w) => w.startsWith("app_live_"));
  await start("resolver", process.execPath, [cli, "serve", "--dir", dir, "--port", String(PORTS.resolver), "--host", "127.0.0.1"], { ready: `http://127.0.0.1:${PORTS.resolver}/.well-known/appport` });
  const { ResolverClient } = await import(path.join(POS_DIR, "node_modules", "@appport", "resolver-client", "dist", "index.js"));
  const admin = await ResolverClient.connect({ url: `http://127.0.0.1:${PORTS.resolver}`, apiKey: adminKey, live: false, maxStaleSeconds: 0 });
  const read = await admin.createKey("personalos-resolve");
  await admin.grant(read.principal, ["read"], "ref://identity/personalos/*");
  const write = await admin.createKey("personalos-link");
  await admin.grant(write.principal, ["write"], "ref://identity/personalos/*");
  SECRETS.add(adminKey); SECRETS.add(read.secret); SECRETS.add(write.secret);
  return { admin, readKey: read.secret, writeKey: write.secret };
}

async function startAuthority() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-authboundry-"));
  const grants = ["identity.read", "identity.write", "principal.read", "principal.write", "policy.read", "policy.write", "agent.read", "agent.write", "delegation.read", "delegation.create", "delegation.revoke", "audit.read", "evidence.read", "authorization.read", "authorization.explain", "session.admin"].flatMap((g) => ["--grant", `authority.${g}=role:owner`]);
  const env = { AUTHBOUNDRY_PORTAL_ORIGIN: "http://localhost:3001", AUTHBOUNDRY_FELTDB_PATH: data, AUTHBOUNDRY_FELTDB_BRIDGE: path.join(AB_PKG, "bridge", "feltdb-store.cjs"), AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE: path.join(AB_PKG, "bridge", "appport-services.cjs"), AUTHBOUNDRY_NODE: process.execPath, FELTDB_URL: "", FELTDB_ENDPOINT: "" };
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
  for (const owner of ["ada", "grace"]) {
    await req("/_authboundry/control-plane/applications/personalos/principals", { method: "POST", credential, body: { id: `user:${owner}`, kind: "human", claims: { role: "owner" } } }).catch(() => undefined);
    await req("/_authboundry/policies", { method: "POST", credential, body: { application: "personalos", principal_id: `user:${owner}`, capabilities: CAPABILITIES } });
  }
  await req("/_authboundry/agents", { method: "POST", credential, body: { id: "agent:personalos", name: "PersonalOS", application: "personalos" } });
  const delegate = (id, owner, caps) => req("/_authboundry/delegations", { method: "POST", credential, body: { id, delegator: `user:${owner}`, delegate: "agent:personalos", capabilities: caps.join(","), application: "personalos" } });
  await delegate("ada-personalos", "ada", CAPABILITIES);
  await delegate("grace-personalos", "grace", CAPABILITIES);
  const { secret } = await req("/_authboundry/control-plane/applications/personalos/check-credentials", { method: "POST", credential, body: { label: "personalos continuity e2e" } });
  SECRETS.add(secret); SECRETS.add(credential);
  return { url: base, checkCredential: secret, revokeDelegation: (id) => req(`/_authboundry/delegations/${id}/revoke`, { method: "POST", credential, body: {} }) };
}

async function devClient(url, user) {
  const { createClient } = await import(path.join(POS_DIR, "node_modules", "@feltdb", "feltkit", "dist", "client", "index.js"));
  let token = null;
  const client = createClient({ url, tokens: { get: () => token, set: (v) => { token = v; } } });
  await client.signInAsDevUser(user);
  return client;
}
const q = (name) => ({ name, kind: "query" });
const m = (name) => ({ name, kind: "mutation" });

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let resolver, authority, posEnv, posState;
  try {
    if (!fs.existsSync(AB_BIN)) throw new Error(`AuthBoundry is not installed: npm ci --prefix ${AB_HOME}`);
    execFileSync("npm", ["run", "extension:build"], { cwd: POS_DIR, stdio: "ignore" });
    resolver = await startResolver();
    authority = await startAuthority();
    posState = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-pos-"));
    posEnv = { FELTKIT_STATE_DIR: posState, RESOLVER_URL: `http://127.0.0.1:${PORTS.resolver}`, FELTKIT_CREDENTIAL_RESOLVER_RESOLVE: resolver.readKey, FELTKIT_CREDENTIAL_RESOLVER_LINK: resolver.writeKey, AUTHBOUNDRY_URL: authority.url, FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK: authority.checkCredential };
    for (const k of ["OPENAISEARCH_URL", "WEBSEARCH_URL", "FELTKIT_CREDENTIAL_AI_GATEWAY", "FELTKIT_CREDENTIAL_OPENAI"]) posEnv[k] = "";
    await start("personalos", "npx", ["feltkit", "dev", "--port", String(PORTS.personalos)], { cwd: POS_DIR, env: posEnv, ready: `${POS}/api/session` });
    const out = execFileSync("npx", ["feltkit", "session", "create", "--id", "multiplayer", "--role", "bridge", "--type", "service", "--label", "Multiplayer bridge (continuity e2e)"], { cwd: POS_DIR, env: { ...process.env, FELTKIT_STATE_DIR: posState }, encoding: "utf8" });
    const bridgeToken = out.split(/\s+/).find((w) => /^fks_/.test(w));
    if (!bridgeToken) throw new Error("feltkit session create printed no token");
    SECRETS.add(bridgeToken);
    const mpState = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-mp-"));
    await start("multiplayer", "npx", ["feltkit", "dev", "--port", String(PORTS.multiplayer)], { cwd: ROOT, env: { FELTKIT_STATE_DIR: mpState, PERSONALOS_URL: POS, FELTKIT_CREDENTIAL_PERSONALOS_BRIDGE: bridgeToken, MULTIPLAYER_INSTANCE: INSTANCE }, ready: `${MP}/api/session` });
  } catch (e) {
    console.log(`ENVIRONMENT: the stack could not start: ${e.message}`);
    evidence.environment = String(e.message);
    fs.writeFileSync(path.join(SHOTS, "evidence.json"), scrub(JSON.stringify({ ...evidence, results }, null, 2)));
    stopAll();
    process.exit(2);
  }
  const restartPersonalOS = async () => {
    await stop("personalos", "SIGKILL", posState);
    const t0 = Date.now();
    await start("personalos", "npx", ["feltkit", "dev", "--port", String(PORTS.personalos)], { cwd: POS_DIR, env: posEnv, ready: `${POS}/api/session` });
    return Date.now() - t0;
  };

  // ── Browsers: Multiplayer (Ada, Grace), PersonalOS's own page (Ada, for linking), Chrome + extension (Ada) ──
  const browser = await chromium.launch();
  const mk = async (who) => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => console.log(`[${who}] pageerror ${e}`)); return page; };
  const ada = await mk("ada-multiplayer");
  const grace = await mk("grace-multiplayer");
  const adaPos = await mk("ada-personalos");
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
  const posAda = await devClient(POS, "ada");
  const posGrace = await devClient(POS, "grace");
  const box = (page, name) => page.getByRole("textbox", { name });
  const say = async (page, text, name = "Message PersonalOS") => { await box(page, name).fill(text); await box(page, name).press("Enter"); };
  /** PersonalOS's reply in Ada's (or Grace's) DM: the newest message matching. */
  const dmReply = async (page, pattern, timeout = 30000) => { const el = page.locator('[data-testid="message"]').filter({ hasText: pattern }).last(); await el.waitFor({ timeout }); return el.innerText(); };
  const openDM = async (page) => {
    await page.getByRole("button", { name: "New message" }).click();
    await page.getByLabel("Find people").fill("personalos");
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Open direct message" }).click();
    await box(page, "Message PersonalOS").waitFor();
  };
  const workOf = (client, conversationId) => client.query(q("continuity:of"), { conversationId });
  globalThis.__pages = () => [ada, grace, ...(chrome?.ctx.pages() ?? [])];

  // The extension in its own Chromium (Ada's Chrome), as built, with the test-only host permissions.
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-ext-"));
  fs.cpSync(path.join(POS_DIR, "extension", "dist"), ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://localhost/*", `${new URL(PAGE).origin}/*`];
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-profile-"));
  let chrome = null;
  const openChrome = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium", viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    const panelUrl = `chrome-extension://${sw.url().split("/")[2]}/sidepanel.html`;
    return { ctx, panelUrl };
  };
  const openPage = async (ctx) => {
    const site = await ctx.newPage();
    await site.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await site.waitForTimeout(2000);
    const selected = await site.evaluate(() => {
      const p = [...document.querySelectorAll("p, h2, h3")].find((x) => (x.textContent ?? "").trim().length > 60 && x.getBoundingClientRect().height > 0);
      const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r);
      return String(getSelection()).trim();
    });
    return { site, selected };
  };
  const openPanel = async (ctx, panelUrl, conversationId = null) => {
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 440, height: 900 });
    await panel.goto(panelUrl + (conversationId ? `#/chat/${conversationId}` : ""));
    const connect = panel.getByRole("button", { name: "Connect" });
    if (await connect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await panel.locator("input").first().fill(`localhost:${PORTS.personalos}`);
      await connect.click();
    }
    await panel.getByLabel("Message").waitFor({ timeout: 60000 });
    return panel;
  };

  // ── Setup: Ada and Grace in Multiplayer, both linked to their PersonalOS accounts ─────────────
  await check(0, "setup: Ada opens Multiplayer, adds @personalos, links her PersonalOS account through a DM (Resolver); Grace links hers", async () => {
    await ada.goto(`${MP}/?as=ada`);
    await ada.getByRole("button", { name: "Open sample workspace" }).click();
    await ada.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 20000 });
    await ada.getByRole("button", { name: "✦ Add @personalos" }).click();
    await ada.getByText(/@personalos joined/).waitFor();
    await adaPos.goto(`${POS}/#/settings`);
    await adaPos.getByRole("button", { name: "Connect Multiplayer" }).click();
    const code = (await adaPos.getByTestId("link-code").innerText()).match(/link ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
    await openDM(ada);
    await say(ada, `link ${code}`);
    await ada.getByText(/^Almost connected\. Open PersonalOS/).waitFor({ timeout: 20000 });
    await adaPos.reload();
    await adaPos.getByTestId("link-presented").getByRole("button", { name: "This is me" }).click();
    await until(async () => (await posAda.query(q("links:list"), {})).some((l) => l.status === "active"), "Ada's link recorded");
    // Grace: invited by e-mail and signed in with an e-mailed code, as in Multiplayer's own e2e. In
    // Multiplayer she is grace@example.com; in PersonalOS the development user "grace".
    const mail = async (subject, since) => until(async () => { const text = logs.multiplayer.slice(since); const at = text.lastIndexOf("✉ grace@example.com: "); return at >= 0 && subject.test(text.slice(at, text.indexOf("\n", at))) ? text.slice(at, at + 2000) : null; }, `e-mail ${subject}`);
    await ada.getByRole("button", { name: /^#\s*general/ }).click();
    await ada.getByRole("button", { name: "＋ Invite people" }).click();
    await ada.getByLabel("E-mail").fill("grace@example.com");
    await ada.getByLabel("Role").selectOption("member");
    await ada.getByRole("button", { name: "Invite", exact: true }).click();
    const invitation = await ada.getByLabel("Invitation link").inputValue();
    await ada.getByRole("button", { name: "Close" }).click();
    await grace.goto(invitation);
    await grace.getByRole("button", { name: "E-mail me a sign-in link" }).first().click();
    const since = logs.multiplayer.length;
    await grace.getByRole("button", { name: "E-mail me a sign-in link" }).click();
    const signInCode = /Or enter this code: (\d{4} \d{4})/.exec(await mail(/Sign in to/, since))[1];
    await grace.getByLabel("Code").fill(signInCode);
    await grace.getByRole("button", { name: "Sign in" }).click();
    await grace.getByRole("button", { name: /^Join / }).click();
    await grace.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 20000 });
    const g = await posGrace.mutation(m("links:start"), {});
    await openDM(grace);
    await say(grace, `link ${g.code}`);
    await grace.getByText(/^Almost connected\./).waitFor({ timeout: 20000 });
    const [presented] = (await posGrace.query(q("links:list"), {})).filter((l) => l.status === "presented");
    await posGrace.mutation(m("links:confirm"), { id: presented.id });
    await until(async () => (await posGrace.query(q("links:list"), {})).some((l) => l.status === "active"), "Grace's link recorded");
    await posAda.mutation(m("memory:add"), { kind: "project", subject: "feltkit", content: "FeltKit is my product: a TypeScript framework for building internal tools and agent-ready applications on an embedded database." });
    await openDM(ada);
    await shot(ada, "00-linked.png");
  });

  // ── A: Multiplayer → Chrome → Multiplayer ────────────────────────────────────────────────────
  let convA = null;
  const stamp = Date.now().toString(36);
  await check("A1", "Multiplayer: Ada asks PersonalOS in a DM for a reminder; a durable task, with Resolver identity and AuthBoundry's decision", async () => {
    await say(ada, `remind me to follow up with Sarah tomorrow at 9am (${stamp})`);
    await dmReply(ada, /remind you to/);
    const i = (await posAda.query(q("interactions:list"), { limit: 10 })).find((x) => x.text.includes(stamp));
    convA = i.conversationId;
    const task = (await posAda.query(q("tasks:list"), {})).find((t) => /Follow up with Sarah/.test(t.title));
    if (!task?.remindAt || i.authority?.outcome !== "allow") throw new Error(`task ${JSON.stringify(task)} authority ${JSON.stringify(i.authority)}`);
    return { conversation: convA, task: task.title, authority: `${i.authority.capability} ${i.authority.outcome} (${i.authority.delegationId})` };
  });

  let chromeA = null;
  await check("A2", "Chrome: the same conversation, opened in the extension's panel, continued with a page shared into it (the form offers the open conversation)", async () => {
    chrome = await openChrome();
    const { site } = await openPage(chrome.ctx);
    const panel = await openPanel(chrome.ctx, chrome.panelUrl, convA);
    await panel.locator(".msg .bubble").filter({ hasText: /follow up with Sarah/i }).first().waitFor({ timeout: 20000 });
    await panel.getByRole("button", { name: "Summon PersonalOS" }).click();
    const form = panel.getByTestId("summon");
    await form.getByText(/Continue the open conversation: /).waitFor({ timeout: 20000 });
    await form.getByLabel("What should PersonalOS do?").fill("Remember this");
    await shot(panel, "A2-chrome-continue-form.png");
    await form.getByRole("button", { name: "Send" }).click();
    await until(async () => (await panel.getByTestId("summon-status").getAttribute("data-state")) === "completed", "the Chrome part to finish", 60000);
    const w = await workOf(posAda, convA);
    chromeA = w.entries.find((x) => x.kind === "invocation");
    if (!chromeA || chromeA.surface !== "Chrome (your browser)" || !chromeA.shared.some((s) => s.includes(new URL(PAGE).host))) throw new Error(JSON.stringify(w.entries));
    await panel.reload();
    await panel.getByTestId("provenance").click();
    await shot(panel, "A2-chrome-provenance.png");
    const strip = await panel.getByTestId("provenance").innerText();
    if (!/Multiplayer \(direct message\)/.test(strip) || !/Chrome \(your browser\)/.test(strip)) throw new Error(strip);
    await site.close();
    return { conversation: convA, parts: w.entries.map((e) => `${e.kind}: ${e.surface} ${e.state}`) };
  });

  await check("A3", "back in Multiplayer: the DM thread is still that conversation; both parts, each with its own surface, material and authority", async () => {
    await say(ada, "status");
    const text = await dmReply(ada, /Where “/);
    if (!/Multiplayer \(direct message\): completed/.test(text) || !/Chrome \(your browser\): completed · asked "Remember this" · shared /.test(text) || !/authority personalos\.memory\.write: allow \(delegation ada-personalos\)/.test(text)) throw new Error(text);
    await shot(ada, "A3-multiplayer-status.png");
    return { reply: text.slice(0, 600) };
  });

  if (process.env.STOP_AFTER === "A") { stopAll(); process.exit(0); }
  // ── B and C: Chrome → (close, restart) → Multiplayer → Chrome ──────────────────────────────────
  let convB = null;
  await check("B1", "Chrome: research summoned from a real page with its selection, in a new conversation; a durable receipt", async () => {
    const { site, selected } = await openPage(chrome.ctx);
    const panel = chrome.ctx.pages().find((p) => p.url().startsWith(chrome.panelUrl)) ?? (await openPanel(chrome.ctx, chrome.panelUrl));
    await panel.getByRole("button", { name: "Close" }).click().catch(() => {});
    await panel.getByRole("button", { name: "Summon PersonalOS" }).click();
    const form = panel.getByTestId("summon");
    await form.getByText(/Include the text you selected/).waitFor({ timeout: 20000 });
    // A new piece of work: the person unticks continuing the conversation open in the panel.
    const continueOpen = form.getByLabel(/Continue the open conversation/);
    if (await continueOpen.isVisible().catch(() => false)) await continueOpen.uncheck();
    await form.getByLabel("What should PersonalOS do?").fill("Research this company and tell me whether it could be a customer for FeltKit.");
    await form.getByRole("button", { name: "Send" }).click();
    await panel.getByTestId("summon-status").waitFor();
    const row = (await posAda.query(q("invocationstate:list"), { limit: 1 }))[0];
    convB = row.conversationId;
    if (convB === convA) throw new Error("expected a new conversation");
    await site.close();
    return { conversation: convB, invocation: row.invocationId, state: row.state, selection: `${selected.length} chars` };
  });

  await check("C1", "the browser is closed while the work runs, and PersonalOS is killed (SIGKILL) and restarted", async () => {
    await chrome.ctx.close();
    chrome = null;
    const restartMs = await restartPersonalOS();
    return { restartMs };
  });

  await check("B2", "Multiplayer: Ada continues that conversation in her DM; she sees the Chrome research, its page and selection, and its true state at that moment (its authority once it has run: C2)", async () => {
    await say(ada, `continue ${convB}`);
    const text = await dmReply(ada, /Continuing “/, 30000);
    // Right after the restart the job may not have run yet: the state is whatever it truly is (accepted,
    // processing or completed); the authority decision exists only once it has run (C2 checks it).
    if (!/Chrome \(your browser\): (accepted|processing|completed) · asked "Research this company/.test(text) || !/selected text from /.test(text)) throw new Error(text);
    await shot(ada, "B2-multiplayer-continue.png");
    return { reply: text.slice(0, 700) };
  });

  await check("C2", "the same work finishes after the restart; Multiplayer's status shows it completed, one research run throughout", async () => {
    const done = await until(async () => { const w = await workOf(posAda, convB); const r = w.entries.find((e) => e.kind === "research"); return r && r.state !== "running" ? w : null; }, "the research to finish", 120000);
    await say(ada, "status");
    const text = await dmReply(ada, /research: (completed|failed|partial)/, 30000);
    if (!/Chrome \(your browser\): completed · asked "Research this company[\s\S]*authority personalos\.research\.run: allow \(delegation ada-personalos\)/.test(text)) throw new Error(text);
    const runs = (await posAda.query(q("research:list"), {})).filter((r) => r.conversationId === convB);
    if (runs.length !== 1) throw new Error(`${runs.length} research runs`);
    evidence.conversationB = done;
    return { research: done.entries.find((e) => e.kind === "research"), reply: text.slice(0, 500) };
  });

  await check("B3", "Chrome reopened: the conversation shows the Multiplayer parts; continuing it again from the page lands in the same conversation, and Multiplayer sees that too", async () => {
    chrome = await openChrome();
    const { site } = await openPage(chrome.ctx);
    const panel = await openPanel(chrome.ctx, chrome.panelUrl, convB);
    await panel.locator(".msg .bubble").filter({ hasText: /continue [a-z0-9]{12}/ }).first().waitFor({ timeout: 20000 });
    await panel.getByTestId("provenance").click();
    const strip = await panel.getByTestId("provenance").innerText();
    if (!/Multiplayer \(direct message\)/.test(strip) || !/Chrome \(your browser\)/.test(strip)) throw new Error(strip);
    await shot(panel, "B3-chrome-reopened.png");
    await panel.getByRole("button", { name: "Close" }).click().catch(() => {});
    await panel.getByRole("button", { name: "Summon PersonalOS" }).click();
    const form = panel.getByTestId("summon");
    await form.getByText(/Continue the open conversation: /).waitFor({ timeout: 20000 });
    await form.getByLabel("What should PersonalOS do?").fill("Remember this");
    await form.getByRole("button", { name: "Send" }).click();
    await until(async () => (await panel.getByTestId("summon-status").getAttribute("data-state")) === "completed", "the second Chrome part", 60000);
    const w = await workOf(posAda, convB);
    const chromeParts = w.entries.filter((e) => e.kind === "invocation");
    if (chromeParts.length !== 2) throw new Error(JSON.stringify(w.entries));
    await say(ada, "status");
    const text = await dmReply(ada, /Remember this/, 30000);
    await site.close();
    return { chromeParts: chromeParts.map((p) => `${p.asked}: ${p.state}`), multiplayer: text.slice(0, 300) };
  });

  // ── E: isolation ─────────────────────────────────────────────────────────────────────────────
  await check("E", "isolation: Grace's conversation and invocation are hers, Ada's are Ada's: by id, from Multiplayer and over the API, neither reaches the other's", async () => {
    await say(grace, `remind me to water the plants tomorrow (${stamp}-g)`);
    await dmReply(grace, /remind you to/);
    const gi = (await posGrace.query(q("interactions:list"), { limit: 5 })).find((x) => x.text.includes(`${stamp}-g`));
    const graceInv = await posGrace.mutation(m("invocations:submit"), { envelope: { contract: "personalos.invocation/1", invocationId: `grace-${stamp}`, surface: { adapter: "browser", device: "Chrome", version: "e2e" }, instruction: "Remember this", context: [{ kind: "url", url: PAGE, title: "page" }], submittedAt: Date.now(), timeZone: "UTC", returnTo: { kind: "page", url: PAGE } } });
    // Grace tries Ada's conversation in Multiplayer; Ada tries Grace's.
    await say(grace, `continue ${convB}`);
    const g = await dmReply(grace, /There's no conversation/);
    await say(ada, `continue ${gi.conversationId}`);
    const a = await dmReply(ada, /There's no conversation/);
    const refusals = [];
    for (const [client, name, args] of [[posGrace, "continuity:of", { conversationId: convB }], [posGrace, "invocationstate:get", { invocationId: (await posAda.query(q("invocationstate:list"), { limit: 1 }))[0].invocationId }], [posAda, "continuity:of", { conversationId: gi.conversationId }], [posAda, "invocationstate:get", { invocationId: graceInv.invocationId }]]) {
      try { await client.query(q(name), args); refusals.push(`${name}: answered`); } catch (e) { refusals.push(`${name}: ${e.code}`); }
    }
    try { await posGrace.mutation(m("invocations:submit"), { envelope: { contract: "personalos.invocation/1", invocationId: `grace-x-${stamp}`, surface: { adapter: "browser" }, instruction: "Remember this", context: [{ kind: "url", url: PAGE }], submittedAt: Date.now(), correlation: { conversationId: convB } } }); refusals.push("submit into Ada's: answered"); } catch (e) { refusals.push(`submit into Ada's: ${e.code}`); }
    if (refusals.some((r) => !/NOT_FOUND$/.test(r))) throw new Error(refusals.join("; "));
    // Back to Ada's own thread for what follows.
    await say(ada, `continue ${convB}`);
    await dmReply(ada, /Continuing “/);
    return { grace: g.slice(0, 120), ada: a.slice(0, 120), refusals };
  });

  // ── D: authority changes ─────────────────────────────────────────────────────────────────────
  await check("D", "authority: Ada's delegation revoked in AuthBoundry; continuing in Multiplayer is refused, a Chrome share into the conversation is refused when it runs; both refusals are kept in its history", async () => {
    await authority.revokeDelegation("ada-personalos");
    await say(ada, "status");
    const refused = await dmReply(ada, /aren't allowed to continue PersonalOS conversations/);
    chrome.ctx.pages().forEach(() => {});
    const panel = chrome.ctx.pages().find((p) => p.url().startsWith(chrome.panelUrl));
    const { site } = await openPage(chrome.ctx);
    await panel.bringToFront();
    await panel.getByRole("button", { name: "Close" }).click().catch(() => {});
    await panel.getByRole("button", { name: "Summon PersonalOS" }).click();
    const form = panel.getByTestId("summon");
    await form.getByText(/Continue the open conversation: /).waitFor({ timeout: 20000 });
    await form.getByLabel("What should PersonalOS do?").fill("Research this company and tell me whether it could be a customer for FeltKit.");
    await form.getByRole("button", { name: "Send" }).click();
    await until(async () => (await panel.getByTestId("summon-status").getAttribute("data-state")) === "failed", "the refused Chrome part", 60000);
    await shot(panel, "D-chrome-refused.png");
    const w = await workOf(posAda, convB);
    const denials = w.entries.filter((e) => e.authority?.outcome === "deny");
    if (denials.length < 2 || !denials.some((e) => e.kind === "interaction") || !denials.some((e) => e.kind === "invocation")) throw new Error(JSON.stringify(w.entries.map((e) => [e.kind, e.surface, e.state, e.authority])));
    evidence.conversationBAfterRevocation = w;
    await site.close();
    return { multiplayer: refused.slice(0, 200), denials: denials.map((d) => `${d.surface}: ${d.authority.capability} ${d.authority.outcome} (${d.authority.reason ?? ""}) decision ${d.authority.decisionId ?? "?"}`) };
  });

  for (const [name, text] of Object.entries(logs)) fs.writeFileSync(path.join(SHOTS, `log-${name}.txt`), scrub(text));
  evidence.finished = new Date().toISOString();
  fs.writeFileSync(path.join(SHOTS, "evidence.json"), scrub(JSON.stringify({ ...evidence, results }, null, 2)));
  await chrome?.ctx.close().catch(() => {});
  await browser.close();
  stopAll();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); stopAll(); process.exit(1); });
