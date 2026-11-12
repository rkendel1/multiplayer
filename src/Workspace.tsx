import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { AccountSettings, AuthNotices, InvitationsPanel, TenantSettings, TenantSwitcher, VerifyEmailBanner, useAuth, useEvent, useFeltKit, useMutation, useQueryState, useTenant } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Logo } from "./App";
import { ThemeToggle } from "./theme";
import { ago, Avatar, bytes, clock, day, Modal, useNow, type useToasts } from "./ui";

type Toasts = ReturnType<typeof useToasts>;
type Me = { id: string; displayName: string; handle: string };
type Member = { participantId: string; handle: string; displayName: string; title: string | null; kind: string; agentType: string | null; persona: boolean; lastSeenAt: number | null; status: string | null };
type Panel = { kind: "details" } | { kind: "thread"; rootId: string } | { kind: "plan"; id: string } | { kind: "members" } | { kind: "activity" } | { kind: "search"; q: string } | { kind: "inbox" } | null;

const EMOJI = ["👍", "❤️", "😂", "🎉", "🚀", "👀", "✅", "🙏"];
const ONLINE_MS = 60_000;

/**
 * The session's workspace. `workspaceId` is FeltKit's current tenant (useTenant().current.id): the
 * server takes the workspace from the session and refuses any other id, so it is passed only where a
 * function still has the argument. Switching, members, invitations and the account are FeltKit's screens.
 */
export function WorkspaceView(props: { workspaceId: string; me: Me; live: boolean; toasts: Toasts }) {
  const { workspaceId, me, toasts } = props;
  const auth = useAuth();
  const tenant = useTenant();
  const canManage = Boolean(tenant.settings?.can?.manageMembers);
  const [view, setView] = useState<"chat" | "settings" | "account">("chat");
  const ws = useQueryState(api.workspaces.get, { workspaceId });
  const chans = useQueryState(api.channels.list, { workspaceId });
  const [channelId, setChannelId] = useState<string | null>(() => sessionStorage.getItem(`mp:ch:${workspaceId}`));
  const [panel, setPanel] = useState<Panel>(null);
  const [pane, setPane] = useState<"nav" | "chat" | "panel">("chat");
  const [modal, setModal] = useState<null | "channel" | "dm" | "invite" | "addMembers">(null);
  const heartbeat = useMutation(api.presence.heartbeat);
  const typingIn = useMutation(api.presence.typingIn);
  const now = useNow(5000);
  const skew = useRef(0);
  if (ws.data) skew.current = ws.data.now - Date.now();

  // Presence: a heartbeat every 20 s and on visibility changes (it is a small write, so a page opened later sees who is around).
  useEffect(() => {
    // A refused heartbeat means the membership ended or changed: ask FeltKit again (a fallback; FeltKit's
    // change stream normally refreshes the session as soon as a membership changes).
    const beat = () => void heartbeat({ workspaceId, status: document.visibilityState === "visible" ? "active" : "away" }).catch((e) => {
      if (e?.code === "FORBIDDEN" || e?.code === "NOT_FOUND") { auth.refresh(); tenant.refresh(); }
    });
    beat();
    const t = setInterval(beat, 20_000);
    document.addEventListener("visibilitychange", beat);
    return () => (clearInterval(t), document.removeEventListener("visibilitychange", beat));
  }, [workspaceId]);

  // Choose a conversation: the remembered one if still visible, else #general.
  // A conversation that was listed and no longer is (left, removed) falls back too. One just created
  // is not listed until the live query catches up, so absence alone is not a reason to move.
  const listed = useRef(new Set<string>());
  useEffect(() => {
    if (!chans.data) return;
    const ids = new Set(chans.data.map((c) => c.id));
    const vanished = channelId !== null && listed.current.has(channelId) && !ids.has(channelId);
    listed.current = ids;
    if (!channelId || vanished) {
      const first = chans.data.find((c) => c.isDefault && c.name === "general") ?? chans.data.find((c) => c.isMember) ?? chans.data[0];
      setChannelId(first?.id ?? null);
    }
  }, [chans.data, channelId]);
  useEffect(() => { if (channelId) sessionStorage.setItem(`mp:ch:${workspaceId}`, channelId); }, [channelId]);

  // Removed from the workspace (or demoted) while looking at it: FeltKit's session has no workspace
  // role here any more. Ask FeltKit again; the shell then shows the remaining workspaces.
  useEffect(() => {
    if (ws.error?.code === "NOT_FOUND" || ws.error?.code === "FORBIDDEN") { toasts.error("You no longer have access to that workspace."); auth.refresh(); tenant.refresh(); }
  }, [ws.error]);

  const members = ws.data?.members ?? [];
  const online = useCallback((m: Member) => m.kind === "agent" ? true : m.lastSeenAt !== null && now + skew.current - m.lastSeenAt < ONLINE_MS, [now]);
  const open = (id: string) => { setView("chat"); setChannelId(id); setPane("chat"); if (panel?.kind === "thread" || panel?.kind === "details") setPanel(null); };
  const openPanel = (p: Panel) => { setPanel(p); if (p) setPane("panel"); };
  const totalUnread = (chans.data ?? []).reduce((n, c) => n + c.unread, 0);

  useEffect(() => {
    document.title = `${totalUnread ? `(${totalUnread}) ` : ""}${ws.data?.name ?? "Multiplayer"} · Multiplayer`;
  }, [totalUnread, ws.data?.name]);

  if (ws.error && ws.error.code !== "NOT_FOUND" && ws.error.code !== "FORBIDDEN") return <div className="center"><div className="card narrow error-text" role="alert">{ws.error.message}</div></div>;
  const isAdmin = ws.data?.myRole === "owner" || ws.data?.myRole === "admin";
  const hasAgent = members.some((m) => m.handle === "assistant");
  const hasPersonalOS = members.some((m) => m.handle === "personalos");

  return (
    <div className={`app pane-${pane} ${panel ? "with-panel" : ""}`}>
      <TopBar live={props.live} wsName={ws.data?.name ?? "…"} onSearch={(q) => { setView("chat"); openPanel({ kind: "search", q }); }} onInbox={() => { setView("chat"); openPanel({ kind: "inbox" }); }} onNav={() => setPane("nav")} onAccount={() => { setView("account"); setPane("chat"); }} />
      <nav className="sidebar" aria-label="Conversations">
        <div className="ws-head">
          <span className="ws-icon">{ws.data?.name[0] ?? "·"}</span>
          <TenantSwitcher className="ws-switcher" onSwitched={() => setView("chat")} />
          {ws.data && <span className="role-tag">{ws.data.myRole}</span>}
        </div>
        <div className="side-actions">
          {canManage && <button className="side-btn" onClick={() => setModal("invite")}>＋ Invite people</button>}
          {isAdmin && !hasAgent && <AddAgentButton toasts={toasts} />}
          {isAdmin && !hasPersonalOS && <AddPersonalOSButton toasts={toasts} />}
          <button className="side-btn" onClick={() => { setView("chat"); openPanel({ kind: "members" }); }}>👥 Members · {members.length}</button>
          {ws.data?.myRole !== "guest" && <button className="side-btn" onClick={() => { setView("chat"); openPanel({ kind: "activity" }); }}>🕘 Activity</button>}
          <button className="side-btn" aria-current={view === "settings" ? "page" : undefined} onClick={() => { setView("settings"); setPane("chat"); }}>⚙ Workspace settings</button>
        </div>
        {!chans.data ? <SidebarSkeleton /> : (
          <>
            <Section title="Channels" action={ws.data?.myRole !== "guest" ? { label: "Create a channel", onClick: () => setModal("channel") } : undefined}>
              {chans.data.filter((c) => c.kind === "public" || c.kind === "private").map((c) => (
                <ChanRow key={c.id} active={view === "chat" && c.id === channelId} onClick={() => open(c.id)} unread={c.isMember ? c.unread : 0} mentions={c.mentions} muted={!c.isMember}
                  icon={c.kind === "private" ? "🔒" : "#"} label={c.name} />
              ))}
            </Section>
            <Section title="Direct messages" action={{ label: "New message", onClick: () => setModal("dm") }}>
              {chans.data.filter((c) => c.kind === "dm" || c.kind === "group").map((c) => {
                const other = members.find((m) => m.participantId === c.others[0]?.id);
                return (
                  <ChanRow key={c.id} active={view === "chat" && c.id === channelId} onClick={() => open(c.id)} unread={c.unread} mentions={c.mentions}
                    icon={c.kind === "group" ? <span className="group-count">{c.others.length + 1}</span> : <Avatar name={c.others[0]?.displayName ?? me.displayName} kind={c.others[0]?.kind} size={20} online={other ? online(other) : null} />}
                    label={c.title} />
                );
              })}
              {!chans.data.some((c) => c.kind === "dm" || c.kind === "group") && <p className="muted small pad">No conversations yet.</p>}
            </Section>
          </>
        )}
      </nav>

      <main className="main" aria-label={view === "chat" ? "Conversation" : view === "settings" ? "Workspace settings" : "Account"}>
        <AuthNotices className="notice" />
        <VerifyEmailBanner className="notice" />
        {view !== "chat" ? (
          <div className="settings-view">
            <header className="conv-head"><button className="icon-btn back" onClick={() => setPane("nav")} aria-label="Back to conversations">‹</button><h1>{view === "settings" ? "Workspace settings" : "Your account"}</h1><button className="ghost small" onClick={() => setView("chat")}>Back to conversations</button></header>
            <div className="settings-body">
              {view === "settings" ? <>{isAdmin && !hasAgent && <section className="fk-section agent-box"><h3>Room agent</h3><p className="muted small">@assistant summarizes conversations and writes project plans. It joins as a member with the agent role and reads only conversations it is brought into.</p><AddAgentButton toasts={toasts} /></section>}{isAdmin && !hasPersonalOS && <section className="fk-section agent-box"><h3>PersonalOS</h3><p className="muted small">@personalos works for whoever mentions it, in their own PersonalOS account, once they link it there. It reads only conversations it is brought into, and keeps people's private PersonalOS data out of shared conversations.</p><AddPersonalOSButton toasts={toasts} /></section>}<TenantSettings /></> : <AccountSettings />}
            </div>
          </div>
        ) : channelId ? (
          <Conversation key={channelId} channelId={channelId} me={me} members={members} now={now + skew.current} toasts={toasts}
            onOpenThread={(rootId) => openPanel({ kind: "thread", rootId })} onOpenPlan={(id) => openPanel({ kind: "plan", id })}
            onDetails={() => openPanel({ kind: "details" })} onAddMembers={() => setModal("addMembers")} onBack={() => setPane("nav")} onTyping={(typing) => void typingIn({ channelId, typing }).catch(() => undefined)} />
        ) : chans.data ? <Empty title="No conversations" body="Create a channel to get started." /> : <div className="center muted" role="status">Loading…</div>}
      </main>

      {panel && view === "chat" && (
        <aside className="panel" aria-label="Details">
          <PanelView panel={panel} channelId={channelId} workspaceId={workspaceId} me={me} members={members} myRole={ws.data?.myRole ?? "guest"} online={online} toasts={toasts} now={now + skew.current}
            onClose={() => { setPanel(null); setPane("chat"); }} onOpenThread={(rootId) => openPanel({ kind: "thread", rootId })} onOpenPlan={(id) => openPanel({ kind: "plan", id })}
            onOpenChannel={(id, rootId) => { setChannelId(id); if (rootId) openPanel({ kind: "thread", rootId }); else { setPanel(null); setPane("chat"); } }}
            onTyping={(typing) => channelId && void typingIn({ channelId, typing }).catch(() => undefined)} />
        </aside>
      )}

      {modal === "channel" && <CreateChannel workspaceId={workspaceId} onClose={() => setModal(null)} onCreated={(id) => { setModal(null); open(id); }} toasts={toasts} />}
      {modal === "dm" && <NewConversation workspaceId={workspaceId} me={me} members={members} onClose={() => setModal(null)} onOpen={(id) => { setModal(null); open(id); }} toasts={toasts} />}
      {modal === "invite" && <Modal title="Invite people" onClose={() => setModal(null)} wide><InvitationsPanel /></Modal>}
      {modal === "addMembers" && channelId && <AddMembers channelId={channelId} members={members} onClose={() => setModal(null)} toasts={toasts} />}
    </div>
  );
}

function TopBar(props: { wsName: string; live: boolean; onSearch: (q: string) => void; onInbox: () => void; onNav: () => void; onAccount: () => void }) {
  const auth = useAuth();
  const client = useFeltKit();
  const devUsers = auth.session?.devUsers ?? [];
  const [q, setQ] = useState("");
  const inbox = useQueryState(api.inbox.list, { unread: true });
  const n = inbox.data?.length ?? 0;
  return (
    <header className="topbar">
      <button className="icon-btn nav-toggle" onClick={props.onNav} aria-label="Show conversations">☰</button>
      <div className="brand"><Logo /> <span className="brand-name">Multiplayer</span></div>
      <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) props.onSearch(q.trim()); }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${props.wsName}`} aria-label="Search messages" />
      </form>
      <div className="topbar-right">
        <span className={`live ${props.live ? "on" : ""}`} title={props.live ? "Live: changes appear immediately" : "Reconnecting… changes will catch up from the database"}>
          <span className="dot" /> <span className="live-label">{props.live ? "Live" : "Reconnecting"}</span>
        </span>
        <button className="icon-btn bell" onClick={props.onInbox} aria-label={`Notifications, ${n} unread`}>🔔{n > 0 && <span className="badge">{n}</span>}</button>
        {devUsers.length > 0 && devUsers.some((u) => u.id === auth.user?.id) && (
          <select className="identity" value={auth.user?.id} onChange={(e) => void (e.target.value ? client.signInAsDevUser(e.target.value) : auth.signOut())} aria-label="Signed in as (development)">
            {devUsers.filter((u) => u.type !== "agent").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            <option value="">Sign out</option>
          </select>
        )}
        <button className="ghost account-btn" onClick={props.onAccount} aria-label="Account">{auth.user?.displayName?.split(" ")[0] ?? "Account"}</button>
        <ThemeToggle />
      </div>
    </header>
  );
}

function Section({ title, action, children }: { title: string; action?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section className="side-section">
      <div className="side-title"><span>{title}</span>{action && <button className="icon-btn small" onClick={action.onClick} aria-label={action.label} title={action.label}>＋</button>}</div>
      <ul>{children}</ul>
    </section>
  );
}

function ChanRow(p: { active: boolean; onClick: () => void; unread: number; mentions: number; icon: ReactNode; label: string; muted?: boolean }) {
  return (
    <li>
      <button className={`chan ${p.active ? "active" : ""} ${p.unread ? "unread" : ""} ${p.muted ? "muted" : ""}`} onClick={p.onClick} aria-current={p.active ? "page" : undefined}>
        <span className="chan-icon">{p.icon}</span>
        <span className="truncate">{p.label}</span>
        {p.unread > 0 && <span className={`badge ${p.mentions ? "mention" : ""}`} aria-label={`${p.unread} unread`}>{p.unread}</span>}
      </button>
    </li>
  );
}

function SidebarSkeleton() {
  return <div className="skeleton-list" aria-hidden>{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton" />)}</div>;
}

function Empty({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3><p className="muted">{body}</p>{children}</div>;
}

/**
 * Add the room agent: a FeltKit member with the role "agent" (FeltKit adds agent identities directly;
 * people are invited), then make sure it has a profile so people can mention it.
 */
/**
 * Add PersonalOS: an agent identity added the FeltKit way, then its profile so people can mention it.
 * It acts for whoever mentions it, in that person's own PersonalOS account (after they link it there).
 */
function AddPersonalOSButton({ toasts }: { toasts: Toasts }) {
  const client = useFeltKit();
  const ensure = useMutation(api.personalos.add);
  const add = async () => {
    try {
      await client.addMember("personalos", "agent").catch((e) => { if (e?.code !== "CONFLICT") throw e; });
      await ensure({});
      toasts.info("@personalos joined. Each person links their own PersonalOS account before it acts for them.");
    } catch (e) { toasts.error(e); }
  };
  return <button className="side-btn" onClick={() => void add()}>✦ Add @personalos</button>;
}

/** What a PersonalOS request is doing, in words (its lifecycle as PersonalOS reports it). */
const PHASES: Record<string, string> = {
  received: "received your request, working on it…", understanding: "is understanding your request…", working: "is working on it…",
  awaiting_approval: "is waiting for approval in PersonalOS", needs_clarification: "needs a detail from you (see its reply)",
};

/** PersonalOS requests still open in this conversation: their state, cancel (the requester), and fetching news while approval is pending. */
function PersonalOSRequests({ requests, me, toasts }: { requests: Array<{ id: string; phase: string | null; requestedBy: string }>; me: Me; toasts: Toasts }) {
  const sync = useMutation(api.personalos.sync);
  const cancel = useMutation(api.personalos.cancel);
  const open = requests.filter((r) => r.phase && PHASES[r.phase]);
  const waiting = open.filter((r) => r.phase === "awaiting_approval").map((r) => r.id).join(",");
  // An approval is decided in PersonalOS; this surface asks for news while someone is looking.
  useEffect(() => {
    if (!waiting) return;
    const tick = () => { if (document.visibilityState === "visible") for (const id of waiting.split(",")) void sync({ requestId: id }).catch(() => undefined); };
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [waiting]);
  if (!open.length) return null;
  return <>{open.map((r) => (
    <span key={r.id} className="agent-working personalos-state" data-phase={r.phase}>
      ✦ PersonalOS {PHASES[r.phase!]}
      {r.requestedBy === me.id && r.phase !== "received" && <button className="ghost small" onClick={() => void cancel({ requestId: r.id }).catch(toasts.error)}>Cancel</button>}
    </span>
  ))}</>;
}

function AddAgentButton({ toasts }: { toasts: Toasts }) {
  const client = useFeltKit();
  const list = useMutation(api.agents.add);
  const add = async () => {
    try {
      await client.addMember("assistant", "agent").catch((e) => { if (e?.code !== "CONFLICT") throw e; });
      await list({});
      toasts.info("@assistant joined. Mention it in any conversation.");
    } catch (e) { toasts.error(e); }
  };
  return <button className="side-btn" onClick={() => void add()}>🤖 Add @assistant</button>;
}

// ── Conversation ────────────────────────────────────────────────────────────

function Conversation(props: { channelId: string; me: Me; members: Member[]; now: number; toasts: Toasts; onOpenThread: (id: string) => void; onOpenPlan: (id: string) => void; onDetails: () => void; onAddMembers: () => void; onBack: () => void; onTyping: (typing: boolean) => void }) {
  const { channelId, me, toasts } = props;
  const ch = useQueryState(api.channels.get, { channelId });
  const [before, setBefore] = useState<number | undefined>(undefined);
  const msgs = useQueryState(api.messages.list, { channelId });
  const older = useQueryState(api.messages.list, before !== undefined ? { channelId, beforeSeq: before } : "skip");
  const requests = useQueryState(api.agents.requests, { channelId });
  const markRead = useMutation(api.channels.markRead);
  const join = useMutation(api.channels.join);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const items = useMemo(() => [...(older.data?.items ?? []), ...(msgs.data?.items ?? [])], [older.data, msgs.data]);
  const lastSeq = items.reduce((n, m) => Math.max(n, m.seq), 0);

  // Mark read while visible.
  useEffect(() => {
    if (ch.data?.isMember && lastSeq > ch.data.lastReadSeq && document.visibilityState === "visible") void markRead({ channelId, seq: lastSeq }).catch(() => undefined);
  }, [lastSeq, ch.data?.isMember, ch.data?.lastReadSeq]);

  // Stick to the bottom when new messages arrive, unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs.data]);

  if (ch.error) return <Empty title="Conversation unavailable" body={ch.error.code === "NOT_FOUND" ? "It doesn't exist, or you're no longer a member." : ch.error.message} />;
  const c = ch.data;
  // Typing: an ephemeral event for this conversation (app.event + useEvent); each lasts 5 s unless renewed.
  const [typers, setTypers] = useState<Record<string, { name: string; until: number }>>({});
  useEvent<{ participantId: string; name: string; typing: boolean }>("conversation.typing", { scope: channelId }, (p) => {
    if (p.participantId === me.id) return;
    setTypers((x) => { const next = { ...x }; if (p.typing) next[p.participantId] = { name: p.name, until: Date.now() + 5000 }; else delete next[p.participantId]; return next; });
  });
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const typing = useMemo(() => Object.values(typers).filter((x) => x.until > Date.now()).map((x) => ({ displayName: x.name })), [typers, tick]);
  const working = (requests.data ?? []).filter((r) => r.status === "pending" && !r.phase);
  const title = !c ? "…" : c.kind === "dm" || c.kind === "group" ? c.members.filter((m) => m.participantId !== me.id).map((m) => m.displayName).join(", ") || me.displayName : c.name;

  return (
    <div className="conversation">
      <header className="conv-head">
        <button className="icon-btn back" onClick={props.onBack} aria-label="Back to conversations">‹</button>
        <div className="conv-title">
          <h1>{c?.kind === "private" ? "🔒 " : c?.kind === "public" ? "# " : ""}{title}</h1>
          {c?.topic && <p className="muted truncate">{c.topic}</p>}
        </div>
        <div className="conv-actions">
          {c && c.kind !== "dm" && c.isMember && <button className="ghost small" onClick={props.onAddMembers}>Add people</button>}
          <button className="member-stack" onClick={props.onDetails} aria-label={`Details, ${c?.members.length ?? 0} members`}>
            {(c?.members ?? []).slice(0, 3).map((m) => <Avatar key={m.participantId} name={m.displayName} kind={m.kind} size={22} />)}
            <span>{c?.members.length ?? ""}</span>
          </button>
        </div>
      </header>
      <div className="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} role="log" aria-live="polite" aria-label="Messages">
        {msgs.isLoading && !msgs.data ? <div className="center muted" role="status">Loading messages…</div> : msgs.error ? <Empty title="Couldn't load messages" body={msgs.error.message} /> : (
          <>
            {(older.data ?? msgs.data)?.hasMore && items.length > 0 && <button className="ghost load-older" onClick={() => setBefore(items[0]!.seq)}>Load older messages</button>}
            {items.length === 0 && <Empty title={c?.kind === "dm" ? "Start the conversation" : `Welcome to ${c?.kind === "public" || c?.kind === "private" ? "#" + c.name : "your conversation"}`} body="Messages, files and threads you share here appear for everyone in real time." />}
            <MessageList items={items} me={me} onOpenThread={props.onOpenThread} onOpenPlan={props.onOpenPlan} toasts={toasts} lastReadSeq={c?.lastReadSeq ?? 0} />
          </>
        )}
      </div>
      <div className="conv-foot">
        <div className="typing" aria-live="polite">
          {working.length > 0 && <span className="agent-working">🤖 @assistant is working on {working.length === 1 ? "a request" : `${working.length} requests`}…</span>}
          <PersonalOSRequests requests={(requests.data ?? []).filter((r) => r.status === "pending")} me={me} toasts={toasts} />
          {typing.length > 0 && <span>{typing.map((t) => t.displayName.split(" ")[0]).join(", ")} {typing.length === 1 ? "is" : "are"} typing<span className="dots">…</span></span>}
        </div>
        {c && !c.isMember ? (
          <div className="join-bar"><span>You're viewing <strong>#{c.name}</strong>.</span><button onClick={() => void join({ channelId }).catch(toasts.error)}>Join channel</button></div>
        ) : c ? <Composer channelId={channelId} members={props.members} placeholder={`Message ${c.kind === "public" || c.kind === "private" ? "#" + c.name : title}`} toasts={toasts} onTyping={props.onTyping} onSent={() => (atBottom.current = true)} /> : null}
      </div>
    </div>
  );
}

type Msg = { id: string; seq: number; rootId: string | null; author: { id: string; displayName: string; handle: string; kind: string }; text: string; deleted: boolean; createdAt: number; editedAt: number | null; replyCount: number; lastReplyAt: number | null; attachments: Array<{ id: string; name: string; size: number; contentType: string }>; reactions: Array<{ emoji: string; count: number; mine: boolean; names: string[] }>; shared: { id: string; title: string; tasks: number } | null };

function MessageList({ items, me, onOpenThread, onOpenPlan, toasts, lastReadSeq, inThread }: { items: Msg[]; me: Me; onOpenThread?: (id: string) => void; onOpenPlan: (id: string) => void; toasts: Toasts; lastReadSeq?: number; inThread?: boolean }) {
  let prevDay = "";
  let prev: Msg | null = null;
  const firstUnread = lastReadSeq !== undefined ? items.find((m) => m.seq > lastReadSeq && m.author.id !== me.id)?.id : undefined;
  return (
    <ol className="msg-list">
      {items.map((m) => {
        const d = day(m.createdAt);
        const showDay = d !== prevDay;
        const grouped = !showDay && prev && prev.author.id === m.author.id && m.createdAt - prev.createdAt < 5 * 60_000 && !prev.deleted;
        prevDay = d;
        prev = m;
        return (
          <li key={m.id}>
            {showDay && !inThread && <div className="day-divider"><span>{d}</span></div>}
            {m.id === firstUnread && <div className="unread-divider"><span>New</span></div>}
            <MessageRow m={m} me={me} grouped={Boolean(grouped)} onOpenThread={onOpenThread} onOpenPlan={onOpenPlan} toasts={toasts} />
          </li>
        );
      })}
    </ol>
  );
}

function MessageRow({ m, me, grouped, onOpenThread, onOpenPlan, toasts }: { m: Msg; me: Me; grouped: boolean; onOpenThread?: (id: string) => void; onOpenPlan: (id: string) => void; toasts: Toasts }) {
  const react = useMutation(api.messages.react);
  const edit = useMutation(api.messages.edit);
  const remove = useMutation(api.messages.remove);
  const client = useFeltKit();
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const mine = m.author.id === me.id;
  const download = async (a: { id: string; name: string }) => {
    try {
      // A short-lived file link from the app (FeltKit serves the bytes over HTTP; nothing in base64).
      await openFile(client, a.id);
    } catch (e) { toasts.error(e); }
  };
  if (m.deleted) return <div className={`msg deleted ${grouped ? "grouped" : ""}`}><div className="msg-gutter" /><div className="msg-body"><em className="muted">This message was deleted.</em>{m.replyCount > 0 && onOpenThread && <button className="thread-link" onClick={() => onOpenThread(m.id)}>{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</button>}</div></div>;
  return (
    <div className={`msg ${grouped ? "grouped" : ""} ${m.author.kind === "agent" ? "from-agent" : ""}`} data-testid="message">
      <div className="msg-gutter">{grouped ? <span className="hover-time">{clock(m.createdAt)}</span> : <Avatar name={m.author.displayName} kind={m.author.kind} size={36} />}</div>
      <div className="msg-body">
        {!grouped && <div className="msg-meta"><strong>{m.author.displayName}</strong>{m.author.kind === "agent" && <span className="tag agent-tag">AGENT</span>}<time className="muted small" dateTime={new Date(m.createdAt).toISOString()}>{clock(m.createdAt)}</time></div>}
        {editing !== null ? (
          <form className="edit-form" onSubmit={(e) => { e.preventDefault(); void edit({ messageId: m.id, text: editing }).then(() => setEditing(null), toasts.error); }}>
            <textarea value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Edit message" autoFocus rows={2} />
            <div className="row"><button type="submit" className="small" disabled={!editing.trim()}>Save</button><button type="button" className="ghost small" onClick={() => setEditing(null)}>Cancel</button></div>
          </form>
        ) : m.text && <div className="msg-text"><RichText text={m.text} />{m.editedAt && <span className="muted small"> (edited)</span>}</div>}
        {m.attachments.map((a) => (
          <button key={a.id} className="file-chip" onClick={() => void download(a)} title={`Download ${a.name}`} aria-label={`Download ${a.name}, ${bytes(a.size)}`}>
            <span className="file-icon">{a.contentType.startsWith("image/") ? "🖼" : "📄"}</span><span><strong>{a.name}</strong><br /><span className="muted small">{bytes(a.size)} · Download</span></span>
          </button>
        ))}
        {m.shared && (
          <button className="plan-card" onClick={() => onOpenPlan(m.shared!.id)}>
            <span className="plan-kicker">PROJECT PLAN</span><strong>{m.shared.title}</strong><span className="muted small">{m.shared.tasks} tasks · Open plan →</span>
          </button>
        )}
        {(m.reactions.length > 0) && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} className={`reaction ${r.mine ? "mine" : ""}`} onClick={() => void react({ messageId: m.id, emoji: r.emoji }).catch(toasts.error)} title={r.names.join(", ")} aria-pressed={r.mine} aria-label={`${r.emoji} ${r.count}, ${r.names.join(", ")}`}>
                {r.emoji} <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {m.replyCount > 0 && onOpenThread && (
          <button className="thread-link" onClick={() => onOpenThread(m.id)}>{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}<span className="muted small"> · last {ago(m.lastReplyAt ?? m.createdAt)}</span></button>
        )}
      </div>
      <div className="msg-actions" role="toolbar" aria-label="Message actions">
        <button className="icon-btn" onClick={() => setPicker((x) => !x)} aria-label="Add reaction" aria-expanded={picker}>☺</button>
        {onOpenThread && <button className="icon-btn" onClick={() => onOpenThread(m.id)} aria-label="Reply in thread">💬</button>}
        {mine && <button className="icon-btn" onClick={() => setEditing(m.text)} aria-label="Edit message">✎</button>}
        {mine && <button className="icon-btn" onClick={() => confirm("Delete this message?") && void remove({ messageId: m.id }).catch(toasts.error)} aria-label="Delete message">🗑</button>}
        {picker && (
          <div className="emoji-picker" role="menu">
            {EMOJI.map((e) => <button key={e} role="menuitem" onClick={() => { setPicker(false); void react({ messageId: m.id, emoji: e }).catch(toasts.error); }} aria-label={`React ${e}`}>{e}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

/** **bold**, @mentions, bullet lines, links. Everything else is text (React escapes it). */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const bullet = /^\s*[•\-*]\s+/.test(line);
        const body = bullet ? line.replace(/^\s*[•\-*]\s+/, "") : line;
        const parts: ReactNode[] = [];
        const re = /(\*\*[^*]+\*\*|@[a-z0-9-]+|https?:\/\/[^\s)]+)/gi;
        let last = 0;
        for (const m of body.matchAll(re)) {
          if (m.index! > last) parts.push(body.slice(last, m.index));
          const t = m[0];
          if (t.startsWith("**")) parts.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
          else if (t.startsWith("@")) parts.push(<span key={m.index} className="mention">{t}</span>);
          else parts.push(<a key={m.index} href={t} target="_blank" rel="noreferrer noopener">{t}</a>);
          last = m.index! + t.length;
        }
        parts.push(body.slice(last));
        return bullet ? <div key={i} className="bullet">• {parts}</div> : <div key={i}>{parts.length ? parts : " "}</div>;
      })}
    </>
  );
}

function Composer({ channelId, rootId, members, placeholder, toasts, onTyping, onSent }: { channelId: string; rootId?: string; members: Member[]; placeholder: string; toasts: Toasts; onTyping: (typing: boolean) => void; onSent?: () => void }) {
  const send = useMutation(api.messages.send);
  const client = useFeltKit();
  const uploadLink = useMutation(api.attachments.uploadLink);
  const attachFile = useMutation(api.attachments.attach);
  const key = `mp:draft:${channelId}:${rootId ?? ""}`;
  const [text, setText] = useState(() => sessionStorage.getItem(key) ?? "");
  const [files, setFiles] = useState<Array<{ id: string; name: string; size: number }>>([]);
  const [busy, setBusy] = useState(false);
  const lastTyping = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { sessionStorage.setItem(key, text); }, [text]);

  const query = /(?:^|\s)@([a-z0-9-]*)$/i.exec(text)?.[1];
  const suggestions = query !== undefined ? members.filter((m) => m.handle.startsWith(query.toLowerCase()) || m.displayName.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6) : [];

  const change = (v: string) => {
    setText(v);
    if (v && Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); onTyping(true); }
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true);
    try {
      // Concurrent posts can conflict on the conversation's order; the server re-runs, and we retry once more.
      const args = { channelId, text, ...(rootId ? { rootId } : {}), ...(files.length ? { attachmentIds: files.map((f) => f.id) } : {}) };
      await send(args).catch((err) => (err?.code === "CONFLICT" ? send(args) : Promise.reject(err)));
      setText(""); setFiles([]); sessionStorage.removeItem(key);
      lastTyping.current = 0; onTyping(false); onSent?.();
    } catch (err) { toasts.error(err); } finally { setBusy(false); input.current?.focus(); }
  };
  const attach = async (list: FileList | null) => {
    for (const f of Array.from(list ?? [])) {
      if (f.size > 1024 * 1024) { toasts.error(`${f.name} is larger than 1 MB, the file service's limit.`); continue; }
      try {
        // The bytes go over a single-use upload link; then the file is bound to this conversation.
        const contentType = f.type || "application/octet-stream";
        const link = await uploadLink({ channelId, name: f.name, contentType });
        const file = await client.uploadFile(link, f, { name: f.name, contentType });
        const a = await attachFile({ channelId, fileId: file.id });
        setFiles((x) => [...x, a]);
      } catch (err) { toasts.error(err); }
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); setText(text.replace(/@([a-z0-9-]*)$/i, `@${suggestions[0]!.handle} `)); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
  };
  return (
    <form className="composer" onSubmit={submit}>
      {suggestions.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Mention someone">
          {suggestions.map((m) => <li key={m.participantId}><button type="button" onClick={() => { setText(text.replace(/@([a-z0-9-]*)$/i, `@${m.handle} `)); input.current?.focus(); }}><Avatar name={m.displayName} kind={m.kind} size={20} /> {m.displayName} <span className="muted">@{m.handle}</span></button></li>)}
        </ul>
      )}
      {files.length > 0 && <div className="pending-files">{files.map((f) => <span key={f.id} className="tag">📎 {f.name} <button type="button" className="icon-btn small" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} aria-label={`Remove ${f.name}`}>×</button></span>)}</div>}
      <textarea ref={input} value={text} onChange={(e) => change(e.target.value)} onKeyDown={onKey} placeholder={placeholder} aria-label={placeholder} rows={1} />
      <div className="composer-bar">
        <label className="icon-btn" title="Attach a file (up to 1 MB)">📎<input type="file" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ""; }} aria-label="Attach a file" /></label>
        <span className="muted small hint">Enter to send · Shift+Enter for a new line · @ to mention</span>
        <button type="submit" className="send" disabled={busy || (!text.trim() && !files.length)} aria-label="Send">{busy ? "…" : "Send ➤"}</button>
      </div>
    </form>
  );
}

// ── Right panel ─────────────────────────────────────────────────────────────

function PanelView(props: { panel: NonNullable<Panel>; channelId: string | null; workspaceId: string; me: Me; members: Member[]; myRole: string; online: (m: Member) => boolean; toasts: Toasts; now: number; onClose: () => void; onOpenThread: (id: string) => void; onOpenPlan: (id: string) => void; onOpenChannel: (id: string, rootId?: string) => void; onTyping: (t: boolean) => void }) {
  const p = props.panel;
  const title = p.kind === "thread" ? "Thread" : p.kind === "plan" ? "Project plan" : p.kind === "members" ? "Members" : p.kind === "activity" ? "Activity" : p.kind === "search" ? `Results for “${p.q}”` : p.kind === "inbox" ? "Notifications" : "Details";
  return (
    <div className="panel-inner">
      <header className="panel-head"><h2>{title}</h2><button className="icon-btn" onClick={props.onClose} aria-label="Close panel">×</button></header>
      <div className="panel-body">
        {p.kind === "thread" && <Thread rootId={p.rootId} {...props} />}
        {p.kind === "plan" && <PlanView id={p.id} />}
        {p.kind === "details" && props.channelId && <Details {...props} channelId={props.channelId} />}
        {p.kind === "members" && <Members {...props} />}
        {p.kind === "activity" && <Activity workspaceId={props.workspaceId} />}
        {p.kind === "search" && <Search q={p.q} {...props} />}
        {p.kind === "inbox" && <Inbox {...props} />}
      </div>
    </div>
  );
}

function Thread(props: { rootId: string; me: Me; members: Member[]; toasts: Toasts; now: number; onOpenPlan: (id: string) => void; onTyping: (t: boolean) => void }) {
  const th = useQueryState(api.messages.thread, { rootId: props.rootId });
  if (th.error) return <Empty title="Thread unavailable" body={th.error.message} />;
  if (!th.data) return <p className="muted" role="status">Loading thread…</p>;
  const channelId = th.data.root.channelId;
  return (
    <div className="thread">
      <MessageList items={[th.data.root]} me={props.me} onOpenPlan={props.onOpenPlan} toasts={props.toasts} inThread />
      <div className="thread-count">{th.data.replies.length} {th.data.replies.length === 1 ? "reply" : "replies"}</div>
      <MessageList items={th.data.replies} me={props.me} onOpenPlan={props.onOpenPlan} toasts={props.toasts} inThread />
      <Composer channelId={channelId} rootId={props.rootId} members={props.members} placeholder="Reply…" toasts={props.toasts} onTyping={props.onTyping} />
    </div>
  );
}

function PlanView({ id }: { id: string }) {
  const plan = useQueryState(api.agents.plan, { id });
  if (plan.error) return <Empty title="Plan unavailable" body={plan.error.message} />;
  const p = plan.data;
  if (!p) return <p className="muted" role="status">Loading plan…</p>;
  const list = (title: string, items: string[]) => items.length > 0 && <section><h3>{title}</h3><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></section>;
  return (
    <article className="plan">
      <h2>{p.title}</h2>
      <p className="muted small">Created by {p.createdByName} · {ago(p.createdAt)} · stored as a durable record, cites {p.sourceMessageIds.length} messages</p>
      <p>{p.summary}</p>
      {list("Goals", p.goals)}
      {p.tasks.length > 0 && (
        <section><h3>Tasks</h3>
          <table className="plan-table"><thead><tr><th>Task</th><th>Owner</th><th>Due</th></tr></thead>
            <tbody>{p.tasks.map((t, i) => <tr key={i}><td>{t.title}</td><td>{t.owner ?? <span className="muted">—</span>}</td><td>{t.due ?? <span className="muted">—</span>}</td></tr>)}</tbody></table>
        </section>
      )}
      {list("Decisions", p.decisions)}
      {list("Risks", p.risks)}
      {list("Open questions", p.openQuestions)}
    </article>
  );
}

function Details(props: { channelId: string; me: Me; members: Member[]; online: (m: Member) => boolean; toasts: Toasts; onOpenPlan: (id: string) => void; workspaceId: string }) {
  const ch = useQueryState(api.channels.get, { channelId: props.channelId });
  const files = useQueryState(api.attachments.list, { channelId: props.channelId });
  const plans = useQueryState(api.agents.plans, { workspaceId: props.workspaceId });
  const setTopic = useMutation(api.channels.setTopic);
  const leave = useMutation(api.channels.leave);
  const client = useFeltKit();
  const [topic, setTopicText] = useState<string | null>(null);
  const c = ch.data;
  if (!c) return <p className="muted" role="status">Loading…</p>;
  const byId = new Map(props.members.map((m) => [m.participantId, m]));
  return (
    <div className="details">
      {c.kind !== "dm" && (
        <section>
          <h3>Topic</h3>
          {topic === null ? <p>{c.topic ?? <span className="muted">No topic</span>} {c.isMember && <button className="link small" onClick={() => setTopicText(c.topic ?? "")}>Edit</button>}</p> : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void setTopic({ channelId: c.id, topic }).then(() => setTopicText(null), props.toasts.error); }}>
              <input value={topic} onChange={(e) => setTopicText(e.target.value)} aria-label="Topic" maxLength={250} /><button className="small" type="submit">Save</button>
            </form>
          )}
        </section>
      )}
      <section>
        <h3>Members · {c.members.length}</h3>
        <ul className="people">{c.members.map((m) => { const w = byId.get(m.participantId); return <li key={m.participantId}><Avatar name={m.displayName} kind={m.kind} size={28} online={w ? props.online(w) : null} /><span><strong>{m.displayName}</strong> <span className="muted small">@{m.handle}</span><br /><span className="muted small">{m.title ?? (m.kind === "agent" ? "Agent" : "")}</span></span></li>; })}</ul>
      </section>
      <section>
        <h3>Files</h3>
        {(files.data ?? []).length === 0 ? <p className="muted small">No files shared yet.</p> : (
          <ul className="files">{files.data!.map((f) => <li key={f.id}><button className="link" onClick={() => void openFile(client, f.id).catch(props.toasts.error)}>📄 {f.name}</button> <span className="muted small">{bytes(f.size)}</span></li>)}</ul>
        )}
      </section>
      <section>
        <h3>Plans</h3>
        {(plans.data ?? []).filter((p) => p.channelId === c.id).length === 0 ? <p className="muted small">Ask <span className="mention">@assistant</span> to “summarize this and create a project plan”.</p> : (
          <ul className="files">{plans.data!.filter((p) => p.channelId === c.id).map((p) => <li key={p.id}><button className="link" onClick={() => props.onOpenPlan(p.id)}>📋 {p.title}</button></li>)}</ul>
        )}
      </section>
      {c.isMember && !c.isDefault && c.kind !== "dm" && <button className="ghost danger" onClick={() => void leave({ channelId: c.id }).catch(props.toasts.error)}>Leave {c.kind === "group" ? "conversation" : "#" + c.name}</button>}
    </div>
  );
}

/** Who is here and who is around (the workspace directory, with presence). Roles, removal and leaving: Workspace settings (FeltKit). */
function Members(props: { me: Me; members: Member[]; online: (m: Member) => boolean; now: number }) {
  const sorted = [...props.members].sort((a, b) => Number(props.online(b)) - Number(props.online(a)));
  return (
    <ul className="people members">
      {sorted.map((m) => (
        <li key={m.participantId}>
          <Avatar name={m.displayName} kind={m.kind} size={32} online={props.online(m)} />
          <span className="grow">
            <strong>{m.displayName}</strong>{m.participantId === props.me.id && <span className="muted small"> (you)</span>} <span className="muted small">@{m.handle}</span><br />
            <span className="muted small">{m.kind === "agent" ? `${m.agentType ?? ""} agent` : m.title ?? ""}{m.persona ? " · sample" : ""} · {m.kind === "agent" ? "always on" : props.online(m) ? (m.status === "away" ? "away" : "active") : m.lastSeenAt ? `seen ${ago(m.lastSeenAt, props.now)}` : "offline"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Activity({ workspaceId }: { workspaceId: string }) {
  const log = useQueryState(api.activity.list, { workspaceId });
  if (log.error) return <Empty title="Activity unavailable" body={log.error.message} />;
  if (!log.data) return <p className="muted" role="status">Loading…</p>;
  return <ol className="activity">{log.data.map((a) => <li key={a.id}><span className="act-type">{a.type}</span><span>{a.summary}</span><time className="muted small">{ago(a.at)}</time></li>)}</ol>;
}

function Search(props: { q: string; workspaceId: string; me: Me; toasts: Toasts; onOpenChannel: (id: string, rootId?: string) => void; onOpenPlan: (id: string) => void }) {
  const res = useQueryState(api.messages.search, { workspaceId: props.workspaceId, q: props.q });
  if (res.error) return <Empty title="Search failed" body={res.error.message} />;
  if (!res.data) return <p className="muted" role="status">Searching…</p>;
  if (!res.data.length) return <Empty title="No results" body="Search covers every conversation you can read." />;
  return (
    <ul className="search-results">
      {res.data.map((m) => (
        <li key={m.id}>
          <button className="result" onClick={() => props.onOpenChannel(m.channel.id, m.rootId ?? (m.replyCount ? m.id : undefined))}>
            <span className="muted small">{m.channel.kind === "public" || m.channel.kind === "private" ? `#${m.channel.name}` : "Direct message"} · {m.author.displayName} · {ago(m.createdAt)}</span>
            <span><Highlight text={m.text} q={props.q} /></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function Inbox(props: { workspaceId: string; toasts: Toasts; onOpenChannel: (id: string, rootId?: string) => void }) {
  const inbox = useQueryState(api.inbox.list, {});
  const read = useMutation(api.inbox.markRead);
  if (!inbox.data) return <p className="muted" role="status">Loading…</p>;
  if (!inbox.data.length) return <Empty title="You're all caught up" body="Mentions, agent replies and accepted invitations show up here." />;
  return (
    <ul className="inbox">
      {inbox.data.map((n) => {
        const data = (n.data ?? {}) as { workspaceId?: string; channelId?: string; messageId?: string };
        return (
          <li key={n.id} className={n.read ? "" : "unread"}>
            <button className="result" onClick={() => { if (!n.read) void read({ id: n.id }).catch(() => undefined); if (data.channelId && data.workspaceId === props.workspaceId) props.onOpenChannel(data.channelId); }}>
              <strong>{n.title}</strong><span className="muted small">{ago(Date.parse(n.createdAt))}{data.workspaceId && data.workspaceId !== props.workspaceId ? " · another workspace" : ""}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Modals ──────────────────────────────────────────────────────────────────

function CreateChannel({ workspaceId, onClose, onCreated, toasts }: { workspaceId: string; onClose: () => void; onCreated: (id: string) => void; toasts: Toasts }) {
  const create = useMutation(api.channels.create);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { onCreated(await create({ workspaceId, name, kind, ...(topic.trim() ? { topic } : {}) })); } catch (err) { toasts.error(err); } finally { setBusy(false); } };
  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. plan-budget" required maxLength={80} /></label>
        <label className="field"><span>Topic <span className="muted">(optional)</span></span><input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} /></label>
        <fieldset className="choice"><legend>Visibility</legend>
          <label><input type="radio" checked={kind === "public"} onChange={() => setKind("public")} /> <strong>Public</strong> — anyone in the workspace can find and join</label>
          <label><input type="radio" checked={kind === "private"} onChange={() => setKind("private")} /> <strong>Private</strong> — only people you add</label>
        </fieldset>
        <button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create channel"}</button>
      </form>
    </Modal>
  );
}

function NewConversation({ workspaceId, me, members, onClose, onOpen, toasts }: { workspaceId: string; me: Me; members: Member[]; onClose: () => void; onOpen: (id: string) => void; toasts: Toasts }) {
  const openConv = useMutation(api.channels.openConversation);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const others = members.filter((m) => m.participantId !== me.id && (m.displayName.toLowerCase().includes(filter.toLowerCase()) || m.handle.includes(filter.toLowerCase())));
  return (
    <Modal title="New message" onClose={onClose}>
      <div className="stack">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find people" aria-label="Find people" />
        <ul className="people pick">
          {others.map((m) => (
            <li key={m.participantId}><label><input type="checkbox" checked={picked.includes(m.participantId)} onChange={(e) => setPicked((x) => e.target.checked ? [...x, m.participantId] : x.filter((y) => y !== m.participantId))} /> <Avatar name={m.displayName} kind={m.kind} size={24} /> {m.displayName} <span className="muted small">@{m.handle}</span></label></li>
          ))}
        </ul>
        <button disabled={!picked.length} onClick={() => void openConv({ workspaceId, participantIds: picked }).then(onOpen, toasts.error)}>{picked.length > 1 ? `Start group conversation (${picked.length + 1})` : "Open direct message"}</button>
      </div>
    </Modal>
  );
}

function AddMembers({ channelId, members, onClose, toasts }: { channelId: string; members: Member[]; onClose: () => void; toasts: Toasts }) {
  const ch = useQueryState(api.channels.get, { channelId });
  const add = useMutation(api.channels.addMembers);
  const [picked, setPicked] = useState<string[]>([]);
  const inside = new Set((ch.data?.members ?? []).map((m) => m.participantId));
  const candidates = members.filter((m) => !inside.has(m.participantId));
  return (
    <Modal title={`Add people to ${ch.data?.kind === "group" ? "this conversation" : "#" + (ch.data?.name ?? "")}`} onClose={onClose}>
      <div className="stack">
        {candidates.length === 0 ? <p className="muted">Everyone in the workspace is already here.</p> : (
          <ul className="people pick">{candidates.map((m) => <li key={m.participantId}><label><input type="checkbox" checked={picked.includes(m.participantId)} onChange={(e) => setPicked((x) => e.target.checked ? [...x, m.participantId] : x.filter((y) => y !== m.participantId))} /> <Avatar name={m.displayName} kind={m.kind} size={24} /> {m.displayName} <span className="muted small">{m.kind === "agent" ? "agent" : m.title ?? ""}</span></label></li>)}</ul>
        )}
        <button disabled={!picked.length} onClick={() => void add({ channelId, participantIds: picked }).then(onClose, toasts.error)}>Add {picked.length || ""}</button>
      </div>
    </Modal>
  );
}

/** Download an attachment through a short-lived file link (attachments:download, client.fileUrl). */
async function openFile(client: ReturnType<typeof useFeltKit>, attachmentId: string) {
  const link = await client.mutation(api.attachments.download, { attachmentId });
  const a = Object.assign(document.createElement("a"), { href: client.fileUrl(link), download: link.name });
  a.click();
}
