/**
 * Two independent browser sessions (separate contexts: separate cookies, sessions) against a running
 * Multiplayer dev server (the room agent is a FeltKit app.agent inside it), plus a phone-sized session. Verifies FeltKit's
 * sign-in (development identity, and an e-mailed sign-in code for a real account), workspaces
 * (create, switch), invitations (invite by e-mail, accept), workspace settings and members (role,
 * removal), the account screen, and Multiplayer's own real-time behaviour: delivery, typing,
 * presence, reactions, threads, unread counts, channel membership, the agent action, reconnection
 * and durable recovery. Writes screenshots and evidence.json.
 *
 * By default it starts `feltkit dev` (fresh state) itself, and reads the
 * development inbox (e-mail is printed to the dev server's stdout: "✉ <to>: <subject>" and the text):
 *
 *   SHOTS=e2e/screenshots node e2e/multiplayer.e2e.cjs   (the default)
 *
 * Against a server you started yourself (then DEV_LOG must name the file the dev server writes to):
 *
 *   BASE=http://localhost:3000 DEV_LOG=/tmp/dev.log node e2e/multiplayer.e2e.cjs
 */
const { chromium, devices } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT ?? 3217);
const BASE = process.env.BASE ?? `http://localhost:${PORT}`;
const SHOTS = path.resolve(process.env.SHOTS ?? path.join(ROOT, "e2e/screenshots"));
const EVIDENCE = process.env.EVIDENCE ?? path.join(SHOTS, "evidence.json");
const GRACE_EMAIL = "grace@example.com";
const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) }); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message ?? e).split("\n")[0] }); console.log(`FAIL ${name}: ${e.message}`); }
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });
/** Time from an action in one session until a locator is visible in the other. */
const seen = async (action, locator, timeout = 5000) => { const t0 = Date.now(); await action(); await locator.waitFor({ state: "visible", timeout }); return Date.now() - t0; };

// ── Servers and the development inbox ───────────────────────────────────────
let devOut = "";
const children = [];
function start(cmd, args, env, onOut) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", (d) => onOut(String(d)));
  child.stderr.on("data", (d) => onOut(String(d)));
  children.push(child);
  return child;
}
/** Stop the servers this script started (their whole process groups: npx starts children). */
const stopAll = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } };
const inbox = () => (process.env.DEV_LOG ? fs.readFileSync(process.env.DEV_LOG, "utf8") : devOut);
/** The newest e-mail to `to` whose subject matches, from the dev server's output. */
async function mail(to, subject, since, timeout = 10000) {
  const t0 = Date.now();
  for (;;) {
    const text = inbox().slice(since);
    const at = text.lastIndexOf(`✉ ${to}: `);
    if (at >= 0 && subject.test(text.slice(at, text.indexOf("\n", at)))) return text.slice(at, at + 2000);
    if (Date.now() - t0 > timeout) throw new Error(`no e-mail to ${to} matching ${subject}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
async function waitFor(url, timeout = 60000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    if (Date.now() - t0 > timeout) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!process.env.BASE) {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "mp-e2e-"));
    start("npx", ["feltkit", "dev", "--port", String(PORT)], { FELTKIT_STATE_DIR: state }, (s) => { devOut += s; });
    await waitFor(`${BASE}/api/session`);
  }
  const browser = await chromium.launch();
  const mk = async (who, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${who}] pageerror ${e}`));
    return { ctx, page };
  };
  const A = await mk("ada");
  const G = await mk("grace");
  const ada = A.page, grace = G.page;
  const stamp = Date.now().toString(36);
  let graceName = GRACE_EMAIL;

  await check("sign-in screen (FeltKit SignIn)", async () => {
    await ada.goto(BASE);
    await ada.getByRole("heading", { name: "Sign in" }).waitFor();
    await ada.getByRole("button", { name: "E-mail me a sign-in link" }).waitFor();
    await shot(ada, "00-sign-in.png");
  });

  await check("ada signs in (development identity) and opens a fresh sample workspace", async () => {
    await ada.goto(`${BASE}/?as=ada`);
    await ada.getByRole("button", { name: "Open sample workspace" }).waitFor({ timeout: 10000 });
    await ada.getByRole("button", { name: "Create workspace" }).waitFor();
    await shot(ada, "01-onboarding.png");
    await ada.getByRole("button", { name: "Open sample workspace" }).click();
    await ada.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 15000 });
  });

  let link = "";
  await check("ada invites grace by e-mail (FeltKit InvitationsPanel); the invitation is e-mailed", async () => {
    const since = inbox().length;
    await ada.getByRole("button", { name: "＋ Invite people" }).click();
    await ada.getByLabel("E-mail").fill(GRACE_EMAIL);
    await ada.getByLabel("Role").selectOption("member");
    await ada.getByRole("button", { name: "Invite", exact: true }).click();
    link = await ada.getByLabel("Invitation link").inputValue();
    await shot(ada, "05-invite.png");
    const m = await mail(GRACE_EMAIL, /Northwind Labs/, since);
    if (!m.includes(link)) throw new Error("the e-mailed invitation does not carry the link");
    await ada.getByRole("button", { name: "Close" }).click();
    return { link: link.replace(/#feltkit-invitation=.*/, "#feltkit-invitation=<token>") };
  });

  await check("grace opens the link, signs in with an e-mailed code, and joins (FeltKit AcceptInvitation)", async () => {
    await grace.goto(link);
    await grace.getByRole("heading", { name: "Join Northwind Labs" }).waitFor();
    await grace.getByRole("button", { name: "E-mail me a sign-in link" }).first().click();
    const since = inbox().length;
    await grace.getByRole("button", { name: "E-mail me a sign-in link" }).click();
    await grace.getByRole("heading", { name: "Check your e-mail" }).waitFor();
    const m = await mail(GRACE_EMAIL, /Sign in to/, since);
    const code = /Or enter this code: (\d{4} \d{4})/.exec(m)[1];
    await grace.getByLabel("Code").fill(code);
    await shot(grace, "05b-accept-sign-in-code.png");
    await grace.getByRole("button", { name: "Sign in" }).click();
    await grace.getByRole("button", { name: "Join Northwind Labs" }).click();
    await grace.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 15000 });
    return { code: "<8 digits from the dev inbox>" };
  });

  await ada.getByRole("button", { name: /^#\s*general/ }).click();
  const adaBox = ada.getByRole("textbox", { name: "Message #general" });
  const graceBox = grace.getByRole("textbox", { name: "Message #general" });

  await check("real-time message delivery (no refresh)", async () => {
    const text = `Hello Grace, welcome aboard! (${stamp})`;
    const ms = await seen(async () => { await adaBox.fill(text); await adaBox.press("Enter"); }, grace.getByText(text));
    return { latencyMs: ms };
  });

  await check("typing indicator", async () => {
    const ms = await seen(() => graceBox.pressSequentially("I'm typing a reply", { delay: 30 }), ada.getByText(/is typing/));
    await Promise.all([shot(ada, "06-typing-ada-sees.png"), shot(grace, "06-typing-grace-types.png")]);
    await graceBox.fill("");
    return { latencyMs: ms };
  });

  await check("presence: grace shows active in ada's member list", async () => {
    await ada.getByRole("button", { name: /Members · / }).click();
    const row = ada.locator(".members li", { hasText: graceName });
    await row.getByText(/active/).waitFor({ timeout: 5000 });
    await shot(ada, "07-presence-members.png");
    await ada.getByRole("button", { name: "Close panel" }).click();
  });

  await check("presence: going away is reflected", async () => {
    await grace.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await ada.getByRole("button", { name: /Members · / }).click();
    await ada.locator(".members li", { hasText: graceName }).getByText(/away/).waitFor({ timeout: 5000 });
    await ada.getByRole("button", { name: "Close panel" }).click();
    await grace.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  });

  const target = grace.locator('[data-testid="message"]', { hasText: `welcome aboard! (${stamp})` });
  await check("reactions propagate", async () => {
    await target.hover();
    await target.getByRole("button", { name: "Add reaction" }).click();
    const ms = await seen(() => target.getByRole("menuitem", { name: "React 🎉" }).click(), ada.locator('[data-testid="message"]', { hasText: stamp }).getByRole("button", { name: /🎉 1/ }));
    return { latencyMs: ms };
  });

  await check("thread replies propagate", async () => {
    await target.hover();
    await target.getByRole("button", { name: "Reply in thread" }).click();
    const reply = grace.getByRole("textbox", { name: "Reply…" });
    const ms = await seen(async () => { await reply.fill("Thanks Ada — glad to be here."); await reply.press("Enter"); }, ada.locator('[data-testid="message"]', { hasText: stamp }).getByRole("button", { name: /1 reply/ }));
    await ada.locator('[data-testid="message"]', { hasText: stamp }).getByRole("button", { name: /1 reply/ }).click();
    await ada.getByText("Thanks Ada — glad to be here.").waitFor();
    await shot(ada, "08-thread.png");
    await ada.getByRole("button", { name: "Close panel" }).click();
    await grace.getByRole("button", { name: "Close panel" }).click();
    return { latencyMs: ms };
  });

  await check("files: upload and download through FeltKit file links (no base64 through functions)", async () => {
    const body = `Launch checklist ${stamp}\n`;
    await ada.locator('input[type="file"]').first().setInputFiles({ name: `checklist-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from(body) });
    await ada.getByText(`📎 checklist-${stamp}.txt`).waitFor();
    await adaBox.fill(`The checklist (${stamp})`);
    await adaBox.press("Enter");
    const chip = grace.getByRole("button", { name: new RegExp(`Download checklist-${stamp}\\.txt`) });
    await chip.waitFor({ timeout: 5000 });
    const [download] = await Promise.all([grace.waitForEvent("download"), chip.click()]);
    const got = fs.readFileSync(await download.path(), "utf8");
    if (got !== body) throw new Error(`downloaded ${JSON.stringify(got)}`);
    if (!/\/api\/files\//.test(download.url())) throw new Error(`not a file link: ${download.url()}`);
    return { url: download.url().replace(/files\/.*/, "files/<token>") };
  });

  await check("unread counts update live", async () => {
    await ada.getByRole("button", { name: /^#\s*random/ }).click();
    const box = ada.getByRole("textbox", { name: "Message #random" });
    const ms = await seen(async () => { await box.fill(`Unread test ${stamp}`); await box.press("Enter"); }, grace.getByRole("button", { name: /random/ }).getByLabel(/unread/));
    return { latencyMs: ms };
  });

  await check("channel membership: grace is added to a new private channel live", async () => {
    await ada.getByRole("button", { name: "Create a channel" }).click();
    await ada.getByLabel("Name").fill(`e2e-${stamp}`);
    await ada.getByLabel(/Private/).check();
    await ada.getByRole("button", { name: "Create channel" }).click();
    await ada.getByRole("heading", { level: 1, name: new RegExp(`e2e-${stamp}`) }).waitFor();
    if (await grace.getByRole("button", { name: new RegExp(`e2e-${stamp}`) }).isVisible()) throw new Error("private channel visible before being added");
    await ada.getByRole("button", { name: "Add people" }).click();
    await ada.getByRole("checkbox", { name: new RegExp(graceName.replace(/[.@]/g, "\\$&")) }).check();
    const ms = await seen(() => ada.getByRole("button", { name: /^Add 1/ }).click(), grace.getByRole("button", { name: new RegExp(`e2e-${stamp}`) }));
    return { latencyMs: ms };
  });

  await check("agent: mention, plan persisted, reply visible to both sessions", async () => {
    await ada.getByRole("button", { name: /launch-q1/ }).click();
    const box = ada.getByRole("textbox", { name: "Message #launch-q1" });
    await box.fill("@assistant summarize this discussion and create a project plan.");
    await box.press("Escape");
    await box.press("Enter");
    const mine = ada.locator('[data-testid="message"]', { hasText: "summarize this discussion" }).last();
    const t0 = Date.now();
    await mine.getByRole("button", { name: /1 reply/ }).waitFor({ timeout: 20000 });
    const agentMs = Date.now() - t0;
    await mine.getByRole("button", { name: /1 reply/ }).click();
    await ada.getByRole("button", { name: /PROJECT PLAN/ }).waitFor();
    await shot(ada, "09-agent-reply-thread.png");
    await ada.getByRole("button", { name: /PROJECT PLAN/ }).click();
    await ada.getByRole("heading", { name: /Project plan:/ }).waitFor();
    await shot(ada, "10-agent-project-plan.png");
    await ada.getByRole("button", { name: "Close panel" }).click();
    // Grace (not a member of #launch-q1, but it is public) sees the same reply.
    await grace.getByRole("button", { name: /launch-q1/ }).click();
    await grace.locator('[data-testid="message"]', { hasText: "summarize this discussion" }).last().getByRole("button", { name: /1 reply/ }).waitFor({ timeout: 5000 });
    return { agentRoundTripMs: agentMs };
  });

  await check("reconnection: offline session catches up from durable state", async () => {
    await grace.getByRole("button", { name: /^#\s*general/ }).click();
    await ada.getByRole("button", { name: /^#\s*general/ }).click();
    await G.ctx.setOffline(true);
    await grace.waitForTimeout(1500);
    const text = `Sent while Grace was offline (${stamp})`;
    await adaBox.fill(text); await adaBox.press("Enter");
    await ada.getByText(text).waitFor();
    await grace.waitForTimeout(1500);
    if (await grace.getByText(text).isVisible()) throw new Error("delivered while offline?");
    const ms = await seen(() => G.ctx.setOffline(false), grace.getByText(text), 20000);
    return { catchUpAfterReconnectMs: ms };
  });

  await check("durable recovery: a fresh page load shows the authoritative state (cookie session survives)", async () => {
    await grace.reload();
    await grace.getByText(`Sent while Grace was offline (${stamp})`).waitFor({ timeout: 10000 });
    await grace.getByText(`welcome aboard! (${stamp})`).waitFor();
    const stored = await grace.evaluate(() => JSON.stringify(Object.keys(localStorage)));
    if (stored.includes("feltkit")) throw new Error(`a session token in localStorage: ${stored}`);
  });

  await check("side-by-side screenshot of both sessions", async () => {
    await ada.getByRole("button", { name: /^#\s*general/ }).click();
    await grace.getByRole("button", { name: /^#\s*general/ }).click();
    await graceBox.pressSequentially("Typing so Ada can see it", { delay: 25 });
    await ada.getByText(/is typing/).waitFor();
    const a = await ada.screenshot(); const g = await grace.screenshot();
    const view = await browser.newPage({ viewport: { width: 2000, height: 660 }, deviceScaleFactor: 1 });
    await view.setContent(`<body style="margin:0;display:flex;gap:16px;padding:16px;background:#222;font:600 16px system-ui;color:#fff">
      <figure style="margin:0;flex:1"><figcaption>Session 1 · Ada (development identity, browser context A)</figcaption><img style="width:100%;border-radius:8px" src="data:image/png;base64,${a.toString("base64")}"></figure>
      <figure style="margin:0;flex:1"><figcaption>Session 2 · grace@example.com (account, browser context B)</figcaption><img style="width:100%;border-radius:8px" src="data:image/png;base64,${g.toString("base64")}"></figure></body>`);
    await view.screenshot({ path: path.join(SHOTS, "04-two-sessions.png"), fullPage: true });
    await view.close();
    await graceBox.fill("");
  });

  await check("account screen (FeltKit AccountSettings): grace's account and sessions", async () => {
    await grace.getByRole("button", { name: "Account" }).click();
    await grace.getByRole("heading", { level: 1, name: "Your account" }).waitFor();
    await grace.getByText(GRACE_EMAIL).first().waitFor();
    await shot(grace, "13-account.png");
    await grace.getByRole("button", { name: "Back to conversations" }).click();
  });

  await check("workspaces: create a second one and switch back (FeltKit TenantSwitcher)", async () => {
    await ada.locator(".ws-switcher > button").click();
    await ada.getByRole("menuitem", { name: "+ New workspace" }).click();
    await ada.getByLabel("Workspace name").fill(`Side project ${stamp}`);
    await ada.getByRole("button", { name: "Create", exact: true }).click();
    await ada.getByRole("heading", { level: 1, name: /general/ }).waitFor({ timeout: 15000 });
    await ada.locator(".ws-switcher > button", { hasText: `Side project ${stamp}` }).waitFor();
    if (await ada.getByRole("button", { name: /launch-q1/ }).isVisible()) throw new Error("the other workspace's channels are visible");
    await ada.locator(".ws-switcher > button").click();
    await shot(ada, "14-switcher.png");
    await ada.getByRole("menuitemradio", { name: /Northwind Labs/ }).click();
    await ada.getByRole("button", { name: /launch-q1/ }).waitFor({ timeout: 15000 });
  });

  await check("workspace settings (FeltKit TenantSettings): members, role change, removal takes effect", async () => {
    await ada.getByRole("button", { name: "⚙ Workspace settings" }).click();
    await ada.getByRole("heading", { name: "Members" }).waitFor();
    const role = ada.getByLabel(`Role of ${graceName}`);
    await role.selectOption("guest");
    await ada.getByText(`${graceName} is now guest.`).waitFor();
    await shot(ada, "15-workspace-settings.png");
    // As a guest, grace no longer sees public channels she is not in (#launch-q1), at once.
    await grace.reload();
    await grace.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 10000 });
    await grace.waitForTimeout(800);
    if (await grace.getByRole("button", { name: /launch-q1/ }).isVisible()) throw new Error("guest still sees #launch-q1");
    // Removed: her session has no workspace any more; she lands on the workspace screen.
    grace.once("dialog", () => undefined);
    ada.once("dialog", (d) => d.accept());
    await ada.getByRole("listitem").filter({ hasText: graceName }).getByRole("button", { name: "Remove" }).click();
    // A membership change reaches the change stream: her open page updates at once (no reload).
    const t0 = Date.now();
    await grace.getByRole("button", { name: "Create workspace" }).waitFor({ timeout: 5000 });
    const noticedMs = Date.now() - t0;
    await ada.getByText(`${graceName} was removed.`).waitFor();
    await shot(grace, "16-removed.png");
    return { removedMemberNoticedMs: noticedMs };
  });

  await check("light/dark/mobile screenshots", async () => {
    await ada.getByRole("button", { name: /launch-q1/ }).click();
    await ada.waitForTimeout(500);
    await shot(ada, "02-workspace-light.png");
    await ada.emulateMedia({ colorScheme: "dark" });
    await ada.waitForTimeout(300);
    await shot(ada, "03-workspace-dark.png");
    await ada.emulateMedia({ colorScheme: "light" });
    const m = await browser.newContext({ ...devices["iPhone 13"] });
    const mp = await m.newPage();
    await mp.goto(`${BASE}/?as=alan`);
    await mp.getByRole("button", { name: "Open sample workspace" }).waitFor({ timeout: 10000 });
    await mp.screenshot({ path: path.join(SHOTS, "11a-mobile-onboarding.png") });
    await mp.getByRole("button", { name: "Open sample workspace" }).click();
    await mp.getByRole("heading", { level: 1, name: /#/ }).waitFor({ timeout: 15000 });
    await mp.getByTestId("message").first().waitFor();
    await mp.screenshot({ path: path.join(SHOTS, "11-mobile-conversation.png") });
    await mp.getByRole("button", { name: "Show conversations" }).click();
    await mp.screenshot({ path: path.join(SHOTS, "12-mobile-sidebar.png") });
    await mp.getByRole("button", { name: "⚙ Workspace settings" }).click();
    await mp.getByRole("heading", { name: "Members" }).waitFor();
    await mp.screenshot({ path: path.join(SHOTS, "12b-mobile-workspace-settings.png") });
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px on the phone`);
    await m.close();
    const s = await browser.newContext({ ...devices["iPhone 13"] });
    const sp = await s.newPage();
    await sp.goto(BASE);
    await sp.getByRole("heading", { name: "Sign in" }).waitFor();
    await sp.screenshot({ path: path.join(SHOTS, "00b-mobile-sign-in.png") });
    await s.close();
  });

  await browser.close();
  stopAll();
  const ok = results.filter((r) => r.ok).length;
  fs.writeFileSync(EVIDENCE, JSON.stringify({ base: BASE, at: new Date().toISOString(), passed: ok, failed: results.length - ok, results }, null, 2));
  console.log(`\n${ok}/${results.length} passed · evidence: ${EVIDENCE}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); stopAll(); process.exit(1); });
