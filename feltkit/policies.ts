/**
 * Multiplayer's declarative policies (FeltKit `app.policy`): who may manage a conversation, and
 * whose messages a caller may change. FeltKit evaluates them for every call on every interface,
 * after the roles and before `authorize` (feltkit/_authz.ts), which still decides who can see a
 * conversation at all. Deny overrides; a function named here is refused unless a rule allows it.
 * Every refusal is durable evidence (`_feltkit_decisions`).
 *
 * The handlers carry none of these checks.
 */
import { app, channels, messages, participants } from "./app.js";
import * as ch from "./channels.js";
import * as msg from "./messages.js";

const creator = { owner: "createdBy", via: { collection: participants, field: "principalId" } } as const;
const author = { owner: "authorId", via: { collection: participants, field: "principalId" } } as const;
const moderator = { tenantRole: ["admin", "owner"] } as const;

// What the UI already offered (channels:get canManage): a workspace admin or owner, or whoever created the conversation.
app.policy({
  id: "channels.manage.admin-or-creator",
  description: "workspace admins and owners, and the conversation's creator, manage it",
  effect: "allow",
  functions: [ch.setTopic, ch.addMembers],
  principals: { types: ["user"] },
  resource: { collection: channels, id: "channelId" },
  when: [{ any: [moderator, creator] }],
});

// The room agent manages a conversation only for the person who created it, within the delegation
// that person granted in AuthBoundry (channels.manage). Revoking it refuses the next call.
app.policy({
  id: "channels.manage.delegated",
  description: "an agent manages a conversation for its creator, within AuthBoundry delegation",
  effect: "allow",
  functions: [ch.setTopic, ch.addMembers],
  principals: { types: ["agent"] },
  resource: { collection: channels, id: "channelId" },
  when: [{ delegated: { capability: "channels.manage", onBehalfOf: { field: "createdBy", via: { collection: participants, field: "principalId" } } } }],
  evidence: "durable",
});

app.policy({
  id: "messages.edit.author",
  description: "only the author edits a message",
  effect: "allow",
  functions: [msg.edit],
  resource: { collection: messages, id: "messageId" },
  when: [author],
});

app.policy({
  id: "messages.remove.author-or-moderator",
  description: "the author, or a workspace admin or owner, deletes a message",
  effect: "allow",
  functions: [msg.remove],
  resource: { collection: messages, id: "messageId" },
  when: [{ any: [author, moderator] }],
  evidence: "durable",
});
