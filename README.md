# Multiplayer

**A real-time workspace for people and AI agents. It is an open-source starter built on [FeltKit](https://getfeltkit.com), by [Boundry](https://boundry.company).**

Multiplayer covers what a team chat product needs:
- **Workspaces:** public and private channels, direct and group messages.
- **Conversation:** threads, reactions, file sharing, search, presence, typing indicators, unread counts and notifications.
- **Accounts and access:** accounts, invitations, roles, and an audit trail.
- **A room agent (`@assistant`):** it reads a conversation and writes a project plan back into it.

It is meant to be read and changed. The whole app is about 2,400 lines, and almost all of it is your
application. Sign-in, sessions, workspaces, memberships, invitations, the account screens,
background agent runs, file transfer and live updates come from FeltKit.

![Two people in the same workspace](docs/screenshots/04-two-sessions.png)

## Quick start

Requires Node 22.

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:3000>.
- **Create an account.** Use a password, or **E-mail me a sign-in link**. In development the e-mail, with its link and 8-digit code, is printed in the terminal.
- **Or sign in as a development identity:** Ada, Grace or Alan. `?as=ada` signs a window in as that identity.
- **Then create a workspace,** or choose **Open sample workspace** for Northwind Labs: sample colleagues, a launch discussion, a private channel, a DM and the agent.

To be two people at once, use two browser profiles or a private window.
- **Invite people.** Owners and admins invite someone by e-mail from **＋ Invite people**. The invitee opens the link, signs in with the invited address and joins.
- **Manage the workspace.** Members, roles, removal, renaming and invitations are under **⚙ Workspace settings**.
- **Your account.** Name, address, password and sessions are under your name in the top bar.

### The room agent

The agent runs inside the app, as `app.agent("assistant", …)` in `feltkit/agents.ts`; there is no separate process.
1. **Add it.** A workspace admin adds it with **Add @assistant**.
2. **Ask it.** In a channel, write `@assistant summarize this discussion and create a project plan.`
3. **It runs as itself.** FeltKit runs the agent after the message is saved, as the agent's own identity and roles. It never uses the identity of the person who asked, and it works only in workspaces it is a member of.
4. **It replies.** It reads the conversation, writes a project plan record, and replies in the thread with a link to it.

Its composer (`feltkit/_compose.ts`) is deterministic and cites the messages it used, so no model or API key is needed.
Replace `compose` with a call to the model of your choice to make it smarter. Its authority does not change.

## How it is built

| Concern | Where |
|---|---|
| Data model | `feltkit/app.ts`: roles, accounts, workspaces (`auth.tenant`), services, and the collections. Workspace data is declared `{ tenant: … }`, so FeltKit scopes every read and write to the session's workspace. |
| Authorization | `feltkit/_authz.ts`: one policy for every function, over HTTP, AppPort and MCP alike: private channels, DMs, and the agent's queue. The workspace and role come from the session, never from the request. |
| Functions | `feltkit/*.ts`: queries and mutations, some published as AppPort capabilities for other apps and agents. |
| UI | `src/`: React. FeltKit's components handle sign-in, invitations, workspace switching, workspace settings and account settings. `styles.css` sets the look, and FeltKit's components pick up its `--accent`, `--surface`, `--ink`, `--line` and `--radius`. |
| Live updates | FeltKit's live queries re-run only when a write could change them. A post in #random does not re-run #general's message list. |
| Files | FeltKit file links. Uploads and downloads go over short-lived links issued only after the conversation is authorized. |

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

Development needs nothing. For production, copy `.env.example` to `.env.local` and set:

| Variable | Why |
|---|---|
| `FELTKIT_AUTH_SECRET` | 32+ random bytes (`openssl rand -base64 32`), the same on every process. It derives sign-in link, invitation and CSRF tokens. |
| `FELTKIT_PUBLIC_URL` | The https URL people open the app at. E-mailed links point there. |
| `MAILPORT_URL`, `MAILPORT_API_KEY` | Account e-mail (sign-in links, verification, invitations) through [Mailerport](https://www.npmjs.com/package/mailerport). Register the sender `auth@…` you set in `feltkit/app.ts`. |

Change `email: { from: … }` in `feltkit/app.ts` to your own domain before you deploy.

## Deploy

```bash
npm run build
```

```bash
npm start
```

`npm start` serves the built app. Or let FeltKit build, verify the build boots, and write a deployment you run:

```bash
npx feltkit deploy --target container
```

- **`container`** (the default): the app and its database state on a volume, in one container.
- **Other targets:** `hosted` and `self-hosted` (Managed FeltDB, or a FeltDB server you operate), `vercel`, `cloudflare` and `fly`. `npx feltkit deploy --help` describes each.

Serve it over HTTPS: browser sessions are `__Host-` cookies.

AppBoundry artifacts are not supported yet. AppBoundry hosts do not provide accounts, workspaces or
application agents, so `feltkit build --target appboundry` stops and says why.

## Test

```bash
npm test
```

There are 25 functional, security and agent tests, each against a fresh database. They cover:
- cross-workspace access;
- private channels and DMs;
- roles and invitations;
- removed members;
- file access;
- agent permissions;
- live-query invalidation.

```bash
npm run test:e2e
```

There are 21 browser checks: two desktop sessions and a phone, against `feltkit dev`. They cover:
- sign-in, invitations by e-mailed code, workspaces and settings, the account screen;
- real-time delivery, typing, presence, reactions, threads, files, unread counts;
- the agent, reconnection and recovery.

They need [Playwright](https://playwright.dev) with Chromium:

```bash
npm i -D playwright
```

```bash
npx playwright install chromium
```

Screenshots are written to `e2e/screenshots/`.

## Make it yours

- **Rename it.** Change `name` in `feltkit/app.ts`; it names the database namespace.
- **Roles.** Edit the `roles` and `auth.tenant.roles` in `feltkit/app.ts`; the screens follow the server's rules.
- **Data.** Add a collection with `{ tenant: { field: "workspaceId" } }` and it is scoped to the workspace with no extra code.
- **Agent.** Give the agent a model in `compose`, or add agents with `app.agent`.

## About

Multiplayer is made by [Boundry](https://boundry.company), the company behind [FeltKit](https://getfeltkit.com).
Questions and contributions are welcome at [github.com/rkendel1/multiplayer](https://github.com/rkendel1/multiplayer).

## License

[MIT](LICENSE) © Boundry
