/**
 * Theme preference rules, shared by the server-rendered bootstrap script and the client provider.
 *
 * Two values are deliberately kept apart: the *mode* is what the user chose (and the only thing
 * persisted), while the *resolved theme* is what is actually painted. Automatic mode derives the
 * resolved theme from the device's own clock, so it must never be stored: a saved "dark" from last
 * night would otherwise survive into the next morning.
 */

export const THEME_MODE_STORAGE_KEY = "polaris-theme-mode";

export const THEME_MODES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export type ResolvedTheme = "light" | "dark";

/** Local-time window that resolves to the light theme: 07:00 (inclusive) to 19:00 (exclusive). */
export const DAY_START_HOUR = 7;
export const NIGHT_START_HOUR = 19;

/**
 * Automatic mode still re-reads the clock on this cadence, so a changed device time zone, a manual
 * clock change or a timer that fired late cannot leave the page on the wrong theme for long.
 */
export const THEME_RECHECK_INTERVAL_MS = 60_000;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

/** 07:00–18:59 is light; anything else is dark. Takes the hour from the device's local clock. */
export function resolveAutomaticTheme(hour: number): ResolvedTheme {
  return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? "light" : "dark";
}

export function resolveTheme(mode: ThemeMode, date: Date = new Date()): ResolvedTheme {
  return mode === "auto" ? resolveAutomaticTheme(date.getHours()) : mode;
}

/**
 * Milliseconds until the next automatic switch. Built from local-time setters so a daylight-saving
 * jump moves the boundary with the wall clock instead of drifting by an hour.
 */
export function millisecondsUntilNextThemeBoundary(date: Date = new Date()): number {
  const boundary = new Date(date.getTime());
  boundary.setMinutes(0, 0, 0);
  const hour = date.getHours();
  if (hour < DAY_START_HOUR) boundary.setHours(DAY_START_HOUR);
  else if (hour < NIGHT_START_HOUR) boundary.setHours(NIGHT_START_HOUR);
  else {
    boundary.setDate(boundary.getDate() + 1);
    boundary.setHours(DAY_START_HOUR);
  }
  return Math.max(0, boundary.getTime() - date.getTime());
}

/** How long to wait before re-resolving: the coming boundary, capped for drift and clock changes. */
export function nextThemeCheckDelay(date: Date = new Date()): number {
  return Math.max(1_000, Math.min(THEME_RECHECK_INTERVAL_MS, millisecondsUntilNextThemeBoundary(date) + 1_000));
}

/** A stored value that is missing, unknown or unreadable always means "automatic". */
export function parseThemeMode(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : "auto";
}

export function readStoredThemeMode(): ThemeMode {
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_MODE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function storeThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // A blocked store only costs persistence; the current session keeps the chosen mode.
  }
}

/** Writes the resolved theme to the document root, together with native control colouring. */
export function applyThemeToDocument(theme: ResolvedTheme, mode: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-theme-mode", mode);
  root.style.colorScheme = theme;
}

/**
 * Runs synchronously in <head>, before the body is painted, so a dark-mode visitor never sees a
 * white flash. The source is a fixed string built from the constants above; nothing here comes from
 * user input, and the whole body is wrapped so a blocked localStorage still resolves from the clock.
 */
export const THEME_BOOTSTRAP_SCRIPT = [
  "(function(){",
  "var root=document.documentElement;",
  'var mode="auto";',
  "try{",
  `var stored=window.localStorage.getItem("${THEME_MODE_STORAGE_KEY}");`,
  'if(stored==="light"||stored==="dark"||stored==="auto"){mode=stored}',
  "}catch(error){}",
  "var hour=new Date().getHours();",
  `var theme=mode==="auto"?((hour>=${DAY_START_HOUR}&&hour<${NIGHT_START_HOUR})?"light":"dark"):mode;`,
  'root.setAttribute("data-theme",theme);',
  'root.setAttribute("data-theme-mode",mode);',
  "root.style.colorScheme=theme;",
  "})();"
].join("");
