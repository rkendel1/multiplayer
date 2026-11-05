/** Small pure helpers shared by function modules. No Node APIs: the backend also runs in AppBoundry's WebAssembly guest. */
import { activity } from "./app.js";

export function record(ctx: { db: { insert(c: any, v: any): Promise<string> } }, workspaceId: string, actorId: string, type: string, summary: string, subjectId?: string) {
  return ctx.db.insert(activity, { workspaceId, actorId, type, summary: summary.slice(0, 300), ...(subjectId ? { subjectId } : {}), at: Date.now() });
}

/** "Ada Lovelace" / "ada@example.com" → "ada", lowercase letters, digits and dashes. */
export function baseHandle(source: string): string {
  const local = source.split("@")[0]!.split(/\s+/)[0]!;
  const h = local.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  return h || "user";
}

/** @handles mentioned in a message, lowercase, unique, in order. */
export function mentionedHandles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9-]{0,31})/gi)) {
    const h = m[2]!.toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export function channelName(name: string): string {
  return name.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
