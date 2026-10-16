"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { MAX_POST_TARGETS } from "@/lib/post-types";
import { PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";

export default function PostAccountPicker({ accounts, selectedIds, disabled, loading, onChange, onOpenAccounts }: {
  accounts: SocialAccount[];
  selectedIds: string[];
  disabled: boolean;
  loading: boolean;
  onChange: (integrationIds: string[]) => void;
  onOpenAccounts: () => void;
}) {
  const translate = useTranslation();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, maxHeight: 320 });

  const positionPanel = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const below = window.innerHeight - bounds.bottom - margin - gap;
    const above = bounds.top - margin - gap;
    const openAbove = below < 200 && above > below;
    const maxHeight = Math.max(80, Math.min(360, openAbove ? above : below));
    const height = Math.min(panel.current.scrollHeight, maxHeight);
    setAnchor({
      left: Math.max(margin, Math.min(bounds.left, window.innerWidth - panel.current.offsetWidth - margin)),
      top: Math.max(margin, openAbove ? bounds.top - gap - height : bounds.bottom + gap),
      maxHeight
    });
  }, []);

  useLayoutEffect(() => {
    if (!open || disabled) return;
    positionPanel();
    panel.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, disabled, positionPanel]);

  useLayoutEffect(() => {
    if (open && !disabled) positionPanel();
  }, [open, disabled, selectedIds.length, accounts.length, loading, positionPanel]);

  useEffect(() => {
    if (!open || disabled) return;
    function dismissOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open, disabled, positionPanel]);

  function closePicker() {
    setOpen(false);
    trigger.current?.focus();
  }

  function toggleAccount(integrationId: string) {
    onChange(selectedIds.includes(integrationId)
      ? selectedIds.filter(selectedId => selectedId !== integrationId)
      : [...selectedIds, integrationId]);
  }

  return (
    <section className="post-platforms" aria-labelledby={`${panelId}-title`}>
      <h2 id={`${panelId}-title`}>{translate("Platforms")}</h2>
      <div className="post-platform-selection">
        {selectedIds.map(integrationId => {
          const account = accounts.find(candidate => candidate.id === integrationId);
          const platform = account ? PLATFORM_META[account.identifier as Platform] : undefined;
          return (
            <span className="post-account-chip" key={integrationId}>
              <span className="posts-platform-mark">{platform?.short || account?.identifier.slice(0, 2).toUpperCase() || "?"}</span>
              <span>{account?.name || integrationId}</span>
              {!disabled && <button type="button" aria-label={`${translate("Remove account")}: ${account?.name || integrationId}`} onClick={() => toggleAccount(integrationId)}><X size={13} aria-hidden="true" /></button>}
            </span>
          );
        })}
        <button ref={trigger} type="button" className="secondary-button post-add-platform" disabled={disabled}
          aria-expanded={open && !disabled} aria-controls={open && !disabled ? panelId : undefined}
          onClick={() => setOpen(current => !current)}>
          <Plus size={14} aria-hidden="true" /> {translate("Add platform")} <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
      {open && !disabled && (
        <div className="post-account-picker" id={panelId} ref={panel} style={anchor}
          role="group" aria-label={translate("Choose accounts")}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setOpen(false);
          }} onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              closePicker();
            }
          }}>
          <div className="post-account-picker-list">
            {loading && !accounts.length ? <p role="status"><Loader2 size={15} className="spin" aria-hidden="true" /> {translate("Loading accounts…")}</p>
              : accounts.length ? accounts.map(account => {
                const selected = selectedIds.includes(account.id);
                return (
                  <label key={account.id} className={`post-picker-account ${selected ? "selected" : ""} ${account.disabled ? "disabled" : ""}`}>
                    <input type="checkbox" checked={selected} disabled={account.disabled || (!selected && selectedIds.length >= MAX_POST_TARGETS)} onChange={() => toggleAccount(account.id)} />
                    <span className="post-picker-platform" aria-hidden="true">{PLATFORM_META[account.identifier as Platform]?.short || account.identifier.slice(0, 2).toUpperCase()}</span>
                    <span className="post-editor-account-copy">
                      <strong>{PLATFORM_META[account.identifier as Platform]?.label || account.identifier}</strong>
                      <small>{account.name}</small>
                      {account.disabled && <small>{translate("Needs reconnect in Postiz")}</small>}
                    </span>
                    {selected && <Check className="post-picker-check" size={16} aria-hidden="true" />}
                  </label>
                );
              }) : <p>{translate("No matching accounts")}</p>}
          </div>
          {selectedIds.length >= MAX_POST_TARGETS && <p className="post-editor-panel-note" role="status">{translate("Account selection is full. Remove an account to choose another.")}</p>}
          <button type="button" className="text-button" onClick={onOpenAccounts}>{translate("Manage accounts")} <Plus size={13} aria-hidden="true" /></button>
        </div>
      )}
    </section>
  );
}
