"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Search, X } from "lucide-react";
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
  const searchInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("all");
  const platforms = useMemo(() => [...new Set(accounts.map(account => account.identifier))], [accounts]);
  const matchingAccounts = accounts.filter(account => (
    (platformFilter === "all" || account.identifier === platformFilter)
    && `${account.name} ${account.identifier}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ));

  useEffect(() => {
    if (open) searchInput.current?.focus();
  }, [open]);

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
        <div className="post-account-picker" id={panelId} onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            closePicker();
          }
        }}>
          <div className="post-account-picker-head">
            <strong>{translate("Choose accounts")}</strong>
            <button type="button" className="text-button" onClick={closePicker}><Check size={14} aria-hidden="true" /> {translate("Done")}</button>
          </div>
          <label className="post-account-search">
            <Search size={15} aria-hidden="true" />
            <input ref={searchInput} value={search} onChange={event => setSearch(event.target.value)} aria-label={translate("Search accounts")} placeholder={translate("Search accounts")} />
          </label>
          <div className="post-account-filters" aria-label={translate("Filter by platform")}>
            {["all", ...platforms].map(platform => (
              <button key={platform} type="button" aria-pressed={platformFilter === platform} onClick={() => setPlatformFilter(platform)}>
                {platform === "all" ? translate("All") : PLATFORM_META[platform as Platform]?.label || platform}
              </button>
            ))}
          </div>
          <div className="post-account-picker-list">
            {loading && !accounts.length ? <p role="status"><Loader2 size={15} className="spin" aria-hidden="true" /> {translate("Loading accounts…")}</p>
              : matchingAccounts.length ? matchingAccounts.map(account => {
                const selected = selectedIds.includes(account.id);
                return (
                  <label key={account.id} className={`post-editor-account ${selected ? "selected" : ""} ${account.disabled ? "disabled" : ""}`}>
                    <input type="checkbox" checked={selected} disabled={account.disabled || (!selected && selectedIds.length >= MAX_POST_TARGETS)} onChange={() => toggleAccount(account.id)} />
                    <span className="posts-platform-mark">{PLATFORM_META[account.identifier as Platform]?.short || account.identifier.slice(0, 2).toUpperCase()}</span>
                    <span className="post-editor-account-copy">
                      <strong>{account.name}</strong>
                      <small>{account.disabled ? translate("Needs reconnect in Postiz") : PLATFORM_META[account.identifier as Platform]?.label || account.identifier}</small>
                    </span>
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
