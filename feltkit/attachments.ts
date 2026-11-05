import { fail, s } from "@feltdb/feltkit";
import { app, attachments } from "./app.js";
import { loadChannel } from "./_authz.js";

/**
 * Files: AppPort Services Files stores the bytes (with checksum and audit) in this app's FeltDB
 * instance. Bytes travel over HTTP through FeltKit's file links, never through the
 * function API: a function that has authorized the conversation issues the link. The conversation a
 * file was shared in is recorded here, and every read is authorized by membership of it.
 *
 *   upload    attachments:uploadLink → client.uploadFile(link, blob) → attachments:attach
 *   download  attachments:download → client.fileUrl(link)
 */
const MAX_BYTES = 1024 * 1024;

/** A single-use upload link for a file to share in this conversation (members only). */
export const uploadLink = app.mutation({
  access: "files.write",
  args: { channelId: s.string(), name: s.string({ minLength: 1, maxLength: 200 }), contentType: s.optional(s.string({ maxLength: 120 })) },
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx, { channelId, name, contentType }) => {
    const { channel } = await loadChannel(ctx, channelId);
    // The metadata is fixed here (the client cannot change it), so attach can check where the file belongs.
    return ctx.services.files.uploadLink({ name: name.trim(), ...(contentType ? { contentType } : {}), metadata: { workspaceId: channel.workspaceId, channelId }, maxBytes: MAX_BYTES });
  },
});

/** Bind a file the caller uploaded through uploadLink to this conversation. Then send it with messages:send. */
export const attach = app.mutation({
  access: "files.write",
  args: { channelId: s.string(), fileId: s.string() },
  returns: s.object({ id: s.string(), name: s.string(), size: s.number(), contentType: s.string() }),
  handler: async (ctx, { channelId, fileId }) => {
    const { channel, participant } = await loadChannel(ctx, channelId);
    const file = await ctx.services.files.get(fileId).catch(() => null);
    const principal = ctx.auth.requirePrincipal();
    if (!file || file.owner !== principal.id || file.metadata.channelId !== channelId || file.metadata.workspaceId !== channel.workspaceId) fail("NOT_FOUND", "File not found.");
    if ((await ctx.db.find(attachments, { fileId })).length) fail("NOT_FOUND", "File not found.");
    const type = file.contentType || "application/octet-stream";
    const id = await ctx.db.insert(attachments, { workspaceId: channel.workspaceId, channelId, fileId, uploaderId: participant.id, name: file.name, size: file.size, contentType: type, createdAt: Date.now() });
    return { id, name: file.name, size: file.size, contentType: type };
  },
});

/** A short-lived download link for a file in a conversation the caller can read. */
/** A short-lived download link. A mutation, not a query: each call issues a link, so nothing may watch it live. */
export const download = app.mutation({
  access: "files.read",
  args: { attachmentId: s.string() },
  returns: s.object({ name: s.string(), contentType: s.string(), size: s.number(), url: s.string(), expiresAt: s.string() }),
  handler: async (ctx, { attachmentId }) => {
    const a = await ctx.db.get(attachments, attachmentId);
    if (!a) fail("NOT_FOUND", "File not found.");
    await loadChannel(ctx, a.channelId);
    const link = await ctx.services.files.link(a.fileId, { disposition: "attachment" });
    return { name: a.name, contentType: a.contentType, size: a.size, ...link };
  },
});

/** Files shared in a conversation (the right panel). */
export const list = app.query({
  access: "files.read",
  args: { channelId: s.string() },
  handler: async (ctx, { channelId }) => {
    await loadChannel(ctx, channelId);
    return (await ctx.db.find(attachments, { channelId }, { orderBy: [{ field: "createdAt", direction: "desc" }] }))
      .filter((a) => a.messageId)
      .map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType, messageId: a.messageId!, createdAt: a.createdAt }));
  },
});
