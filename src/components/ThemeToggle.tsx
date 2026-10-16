"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, Moon, Sun, SunMoon } from "lucide-react";
import { LocaleContext, translate, type UiLanguage } from "@/lib/i18n";
import { useTheme } from "@/components/ThemeProvider";
import { THEME_MODES, type ThemeMode } from "@/lib/theme";

/**
 * Appearance switch, sitting beside the Polaris wordmark like the reference product.
 *
 * The trigger's glyph is driven entirely by CSS from the root theme attributes, so the server and
 * the first client render agree and a dark-mode visitor is not shown a light-mode button. Only the
 * popover depends on React state, and it exists solely after the reader opens it.
 */

/** Keep in step with `.theme-menu { width }` in globals.css. */
const MENU_WIDTH = 268;
const VIEWPORT_MARGIN = 10;

const MODE_ICONS: Record<ThemeMode, typeof Sun> = { auto: SunMoon, light: Sun, dark: Moon };

export default function ThemeToggle({ language: languageOverride }: { language?: UiLanguage }) {
  const contextLanguage = useContext(LocaleContext);
  const language = languageOverride ?? contextLanguage;
  const t = useCallback((text: string) => translate(language, text), [language]);
  const { mode, resolvedTheme, setMode } = useTheme();

  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Partial<Record<ThemeMode, HTMLButtonElement | null>>>({});
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  const positionMenu = useCallback(() => {
    const button = trigger.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - MENU_WIDTH),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)
    );
    // Below the trigger by default, lifted above it when the rail sits near the bottom edge.
    // The estimate covers the tallest translation measured (~240px in Thai) so a menu that fits
    // there is never pushed off the bottom of a short viewport.
    const estimatedHeight = 244;
    const below = rect.bottom + 8;
    const top = below + estimatedHeight > window.innerHeight
      ? Math.max(VIEWPORT_MARGIN, rect.top - estimatedHeight - 8)
      : below;
    setAnchor({ top, left });
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    positionMenu();
    optionRefs.current[mode]?.focus();

    function onPointerDown(event: MouseEvent) {
      if (container.current?.contains(event.target as Node)) return;
      close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    }
    function onViewportChange() {
      positionMenu();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, mode, positionMenu, close]);

  /** Arrow keys walk the three options; the trigger hands off with ArrowDown/ArrowUp. */
  function moveFocus(from: ThemeMode, step: number) {
    const index = THEME_MODES.indexOf(from);
    const next = THEME_MODES[(index + step + THEME_MODES.length) % THEME_MODES.length];
    optionRefs.current[next]?.focus();
  }

  function choose(next: ThemeMode) {
    setMode(next);
    close(true);
  }

  return (
    <div className="theme-toggle" ref={container}>
      <button
        type="button"
        className="theme-toggle-trigger"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Appearance")}
        title={t("Appearance")}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="theme-toggle-glyph" aria-hidden="true">
          <Sun className="theme-glyph theme-glyph-light" size={18} strokeWidth={1.7} />
          <Moon className="theme-glyph theme-glyph-dark" size={18} strokeWidth={1.7} />
        </span>
        <span className="theme-toggle-auto" aria-hidden="true" />
      </button>

      {open && anchor && (
        <div
          className="theme-menu"
          role="menu"
          aria-label={t("Appearance")}
          style={{ top: anchor.top, left: anchor.left }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(mode, event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <p className="theme-menu-title">{t("Appearance")}</p>
          {THEME_MODES.map((option) => {
            const Icon = MODE_ICONS[option];
            const checked = mode === option;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={`theme-option ${checked ? "selected" : ""}`}
                ref={(element) => { optionRefs.current[option] = element; }}
                onClick={() => choose(option)}
              >
                <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                <span className="theme-option-copy">
                  <span className="theme-option-label">
                    {t(option === "auto" ? "Automatic" : option === "light" ? "Light" : "Dark")}
                  </span>
                  {option === "auto" && (
                    // Kept to one short line: the exact window is a detail of the rule, not something
                    // a reader has to weigh when choosing.
                    <span className="theme-option-detail">{t("Always follows this device's time")}</span>
                  )}
                  {option === "light" && <span className="theme-option-detail">{t("Always light")}</span>}
                  {option === "dark" && <span className="theme-option-detail">{t("Always dark")}</span>}
                </span>
                {checked && <Check className="theme-option-check" size={14} strokeWidth={2.4} aria-hidden="true" />}
              </button>
            );
          })}
          <p className="theme-menu-note" role="status">
            {t(mode === "auto"
              ? resolvedTheme === "dark" ? "Automatic — currently dark" : "Automatic — currently light"
              : resolvedTheme === "dark" ? "Dark theme is on" : "Light theme is on")}
          </p>
        </div>
      )}
    </div>
  );
}
