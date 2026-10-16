"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyThemeToDocument,
  nextThemeCheckDelay,
  parseThemeMode,
  readStoredThemeMode,
  resolveTheme,
  storeThemeMode,
  THEME_MODE_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode
} from "@/lib/theme";

interface ThemeContextValue {
  /** What the user chose. `auto` follows the device clock. */
  mode: ThemeMode;
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** True when automatic mode is following the local clock. */
  isAutomatic: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

/**
 * The bootstrap script in the document head has already resolved and applied the theme, so the
 * client reads the same inputs instead of starting from a placeholder. The server has no clock or
 * storage and returns the deterministic defaults; the root attributes come from the script, not
 * from this state, which is why the difference cannot cause a paint flash.
 */
function readInitialThemeState(): ThemeState {
  if (typeof window === "undefined") return { mode: "auto", resolved: "light" };
  const mode = readStoredThemeMode();
  return { mode, resolved: resolveTheme(mode) };
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

/**
 * Holds the theme preference and keeps the document in sync with it. It never remounts its
 * children: switching a theme re-renders the controls that read this context and nothing else, so
 * an open editor, a running generation or an unsaved draft is left exactly as it was.
 */
export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeState>(readInitialThemeState);
  const { mode, resolved } = theme;

  useEffect(() => {
    applyThemeToDocument(resolved, mode);
  }, [resolved, mode]);

  const setMode = useCallback((next: ThemeMode) => {
    storeThemeMode(next);
    setTheme({ mode: next, resolved: resolveTheme(next) });
  }, []);

  // Automatic mode re-reads the clock at the coming boundary and at least once a minute. Resigning
  // the timers when the mode is manual keeps a pinned theme from being disturbed by the clock.
  useEffect(() => {
    if (mode !== "auto") return;
    let timer = 0;
    const syncToClock = () => {
      setTheme(current => {
        if (current.mode !== "auto") return current;
        const next = resolveTheme("auto");
        return current.resolved === next ? current : { ...current, resolved: next };
      });
    };
    const schedule = () => {
      timer = window.setTimeout(() => {
        syncToClock();
        schedule();
      }, nextThemeCheckDelay());
    };
    schedule();

    // A slept laptop, a backgrounded tab or a restored page from the back/forward cache can all
    // wake up on the far side of a boundary with a stale theme; these events close that gap.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") syncToClock();
    };
    window.addEventListener("focus", syncToClock);
    window.addEventListener("pageshow", syncToClock);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", syncToClock);
      window.removeEventListener("pageshow", syncToClock);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [mode]);

  // Another tab of this site changing the mode is the one cross-document signal worth following.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_MODE_STORAGE_KEY) return;
      const next = parseThemeMode(event.newValue);
      setTheme({ mode: next, resolved: resolveTheme(next) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedTheme: resolved, setMode, isAutomatic: mode === "auto" }),
    [mode, resolved, setMode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
