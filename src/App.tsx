import { useEffect, useRef, useState } from "react";
import {
  AcceptInvitation, CreateTenant, SignIn,
  useAuth, useAuthRedirect, useConnectionState, useFeltKit, useMutation, useQueryState, useTenant,
} from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { WorkspaceView } from "./Workspace";
import { Toasts, useToasts } from "./ui";

/**
 * The shell. Sign-in, invitation links, workspaces (FeltKit tenants), members and accounts are
 * FeltKit's (`@feltdb/feltkit/react`); the browser session is FeltKit's HttpOnly cookie. This file
 * decides which screen shows, and enters the current workspace (me:ensure) before showing it.
 */
export function App() {
  const auth = useAuth();
  const tenant = useTenant();
  const client = useFeltKit();
  const { redirect } = useAuthRedirect();
  const live = useConnectionState();
  const toasts = useToasts();
  const [seeding, setSeeding] = useState(false);

  // Development: ?as=<dev user> signs this browser in as that identity (two windows, two people).
  const tried = useRef(false);
  useEffect(() => {
    const wanted = new URLSearchParams(location.search).get("as");
    if (!auth.session || tried.current || !wanted || auth.user?.id === wanted) return;
    if (!auth.session.devUsers?.some((u) => u.id === wanted)) return;
    tried.current = true;
    void client.signInAsDevUser(wanted).catch(toasts.error);
  }, [auth.session, auth.user?.id]);

  const brand = { name: "Multiplayer", logo: "/logo.svg" };
  if (auth.loading) return <div className="center muted" role="status">Connecting…</div>;
  // An invitation link: FeltKit shows it, asks to sign in first if needed, and switches to the workspace.
  if (redirect?.kind === "invitation") return <div className="signed-out"><AcceptInvitation brand={brand} onAccepted={() => toasts.info("You joined the workspace.")} /><Toasts {...toasts} /></div>;
  if (!auth.user) return <div className="signed-out"><SignIn brand={brand} /><Toasts {...toasts} /></div>;
  if (seeding || tenant.loading) return <div className="center muted" role="status">{seeding ? "Setting up the sample workspace…" : "Loading your workspaces…"}</div>;
  if (!tenant.current) return <><Onboarding onSeeding={setSeeding} toasts={toasts} /><Toasts {...toasts} /></>;
  return (
    <>
      <Enter key={`${auth.user.id}:${tenant.current.id}`} workspaceId={tenant.current.id} live={live} toasts={toasts} />
      <Toasts {...toasts} />
    </>
  );
}

/** Enter the session's workspace (profile, default channels), then show it. */
function Enter(props: { workspaceId: string; live: boolean; toasts: ReturnType<typeof useToasts> }) {
  const ensure = useMutation(api.me.ensure);
  const me = useQueryState(api.me.get);
  const [entered, setEntered] = useState(false);
  useEffect(() => { void ensure({}).then(() => setEntered(true), props.toasts.error); }, []);
  if (me.error) return <div className="center"><div className="card narrow error-text" role="alert">{me.error.message}</div></div>;
  if (!entered || !me.data) return <div className="center muted" role="status">Opening the workspace…</div>;
  return <WorkspaceView workspaceId={props.workspaceId} me={me.data.participant} live={props.live} toasts={props.toasts} />;
}

/** No workspace yet (or none chosen): FeltKit's CreateTenant, and the sample workspace. */
function Onboarding({ onSeeding, toasts }: { onSeeding: (on: boolean) => void; toasts: ReturnType<typeof useToasts> }) {
  const client = useFeltKit();
  const auth = useAuth();
  const sample = async () => {
    onSeeding(true);
    try {
      await client.createTenant("Northwind Labs");
      // The room agent (app.agent "assistant", an identity FeltKit knows) joins as a FeltKit member with the role "agent".
      await client.addMember("assistant", "agent").catch((e) => toasts.error(`@assistant could not be added: ${e.message}`));
      await client.mutation(api.me.ensure, {});
      await client.mutation(api.demo.seed, {});
    } catch (e) {
      toasts.error(e);
    } finally {
      onSeeding(false);
    }
  };
  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <div className="brand-hero"><Logo size={34} /> <span>Multiplayer</span></div>
        <p className="lead">Hi {(auth.user?.displayName ?? "there").split(" ")[0]} — workspaces are where your team and your agents work together.</p>
        <CreateTenant title="Your workspaces" className="embedded" />
        <section className="demo-box">
          <div>
            <h2>Explore a sample workspace</h2>
            <p className="muted">Northwind Labs: four colleagues mid-way through planning a launch, a private channel, a DM waiting for you, and the @assistant room agent.</p>
          </div>
          <button className="secondary" onClick={() => void sample()}>Open sample workspace</button>
        </section>
        <p className="muted small"><button className="link" onClick={() => void auth.signOut()}>Sign out</button></p>
      </div>
    </main>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <circle cx="12" cy="13" r="4.2" fill="var(--brand-ink)" />
      <circle cx="21" cy="13" r="4.2" fill="var(--brand-ink)" opacity=".7" />
      <path d="M6 25c1.2-3.6 3.6-5.4 6-5.4s4.8 1.8 6 5.4M15 25c1.2-3.6 3.6-5.4 6-5.4s4.8 1.8 6 5.4" stroke="var(--brand-ink)" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}
