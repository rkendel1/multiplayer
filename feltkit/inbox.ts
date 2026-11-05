import { s } from "@feltdb/feltkit";
import { app } from "./app.js";

/**
 * The signed-in person's notifications (AppPort Services Notifications, e.g. "task.completed"
 * from tasks:setDone). Each principal reads and marks only its own; the service enforces it.
 */
export const list = app.query({
  access: "notifications.read",
  args: { unread: s.optional(s.boolean()) },
  handler: async (ctx, { unread }) =>
    (await ctx.services.notifications.list(unread ? { unread: true } : {})).map((n) => ({ id: n.id, type: n.type, title: n.title, data: n.data ?? null, createdAt: n.createdAt, read: Boolean(n.readAt) })),
});

export const markRead = app.mutation({
  access: "notifications.update",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await ctx.services.notifications.markRead(id);
  },
});
