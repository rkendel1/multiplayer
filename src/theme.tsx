/**
 * Light, dark, or the system's setting. The choice is kept in this browser (localStorage) and
 * applied as data-theme on <html>; every color in styles.css follows it. public/theme.js
 * applies it before first paint.
 */
import { useEffect, useState, type ReactNode } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "app:theme";

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage is blocked (a private window): the choice lasts until the page reloads.
  }
}

const OPTIONS: Array<{ theme: Theme; label: string; icon: ReactNode }> = [
  { theme: "system", label: "System", icon: <><rect x="3" y="4" width="14" height="10" rx="1.5" /><path d="M7.5 17h5M10 14v3" /></> },
  { theme: "light", label: "Light", icon: <><circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></> },
  { theme: "dark", label: "Dark", icon: <path d="M15.5 12.2A6 6 0 0 1 7.8 4.5a6 6 0 1 0 7.7 7.7Z" /> },
];

/** The light / dark / system switch in the top bar. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => apply(theme), [theme]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && setTheme(stored());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button key={o.theme} type="button" role="radio" aria-checked={theme === o.theme} className={theme === o.theme ? "on" : ""} onClick={() => setTheme(o.theme)} title={`${o.label} theme`}>
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {o.icon}
          </svg>
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
