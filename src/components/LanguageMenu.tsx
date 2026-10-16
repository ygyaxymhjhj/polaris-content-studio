"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Globe } from "lucide-react";
import { useTranslation, type UiLanguage } from "@/lib/i18n";

const LANGUAGES: { value: UiLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "th", label: "ไทย" }
];
const VIEWPORT_MARGIN = 10;

export default function LanguageMenu({ language, onChange }: {
  language: UiLanguage;
  onChange: (language: UiLanguage) => void;
}) {
  const translate = useTranslation();
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef(0);
  const leavingWithTab = useRef(false);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  const positionMenu = useCallback(() => {
    if (!trigger.current || !menu.current) return;
    const triggerBounds = trigger.current.getBoundingClientRect();
    const menuBounds = menu.current.getBoundingClientRect();
    const below = triggerBounds.bottom + 8;
    const preferredTop = below + menuBounds.height <= window.innerHeight - VIEWPORT_MARGIN
      ? below : triggerBounds.top - menuBounds.height - 8;
    setAnchor({
      left: Math.max(VIEWPORT_MARGIN, Math.min(triggerBounds.right - menuBounds.width, window.innerWidth - menuBounds.width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(preferredTop, window.innerHeight - menuBounds.height - VIEWPORT_MARGIN))
    });
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  function openMenu(direction: "down" | "up" = "down") {
    leavingWithTab.current = false;
    const selectedIndex = LANGUAGES.findIndex(option => option.value === language);
    initialFocus.current = selectedIndex >= 0 ? selectedIndex : direction === "up" ? LANGUAGES.length - 1 : 0;
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    options.current[initialFocus.current]?.focus();
  }, [open, positionMenu]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, close, positionMenu]);

  return (
    <div className="language-menu" ref={container} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget) || (leavingWithTab.current && event.relatedTarget === trigger.current)) close(false);
    }}>
      <button
        type="button"
        className="language-menu-trigger"
        ref={trigger}
        aria-label={translate("Interface language")}
        title={translate("Interface language")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => open ? close(true) : openMenu()}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" ? "up" : "down");
          }
        }}
      >
        <Globe size={15} strokeWidth={1.7} aria-hidden="true" />
      </button>
      {open && (
        <div className="language-menu-popover" ref={menu} id={menuId} role="menu"
          aria-label={translate("Interface language")} style={anchor}
          onKeyDown={event => {
            if (event.key === "Tab") {
              leavingWithTab.current = true;
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const activeIndex = options.current.findIndex(option => option === document.activeElement);
              const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? LANGUAGES.length - 1
                : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + LANGUAGES.length) % LANGUAGES.length;
              options.current[nextIndex]?.focus();
            }
            // Tab follows the browser's normal order; blur closes after focus leaves the group.
          }}>
          {LANGUAGES.map((option, index) => (
            <button key={option.value} type="button" role="menuitemradio"
              aria-checked={language === option.value} tabIndex={-1}
              className="language-menu-option"
              ref={element => { options.current[index] = element; }}
              onClick={() => { onChange(option.value); close(true); }}>
              <span lang={option.value === "zh" ? "zh-CN" : option.value}>{option.label}</span>
              {language === option.value && <Check size={16} strokeWidth={2} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
