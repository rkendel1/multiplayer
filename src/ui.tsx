/** Small UI primitives: toasts, avatars, time formatting, a modal. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type Toast = { id: number; tone: "error" | "info"; text: string };

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 6000);
  }, []);
  return {
    items,
    error: useCallback((e: unknown) => push("error", typeof e === "string" ? e : describe(e)), [push]),
    info: useCallback((text: string) => push("info", text), [push]),
    dismiss: useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []),
  };
}

export function Toasts({ items, dismiss }: { items: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}

const PALETTE = ["#e11d48", "#7c3aed", "#2563eb", "#0891b2", "#059669", "#d97706", "#db2777", "#4f46e5"];

export function Avatar({ name, kind, size = 32, online }: { name: string; kind?: string; size?: number; online?: boolean | null }) {
  const initials = name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${kind === "agent" ? "agent" : ""}`} style={{ width: size, height: size, fontSize: size * 0.4, background: kind === "agent" ? undefined : PALETTE[h % PALETTE.length] }} aria-hidden>
      {kind === "agent" ? <svg viewBox="0 0 20 20" width={size * 0.6} height={size * 0.6} fill="currentColor"><path d="M10 2a1 1 0 0 1 1 1v1.1A6 6 0 0 1 16 10v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1Zm-2.5 9a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm5 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" /></svg> : initials}
      {online !== undefined && online !== null && <span className={`presence-dot ${online ? "on" : ""}`} />}
    </span>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
export function clock(ms: number) {
  const d = new Date(ms);
  const h = d.getHours();
  return `${(h + 11) % 12 + 1}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
export function day(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function bytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => (window.removeEventListener("keydown", onKey), prev?.focus());
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Tick every `ms` so relative presence/typing state updates without new data. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A refusal or failure, in words for a toast. */
export function describe(error: unknown): string {
  const e = error as { code?: string; message?: string };
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  return e?.message ?? String(error);
}
