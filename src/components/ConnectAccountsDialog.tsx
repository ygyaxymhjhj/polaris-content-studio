"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { DEFAULT_PLATFORMS, PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  configured: boolean;
  uiUrl: string;
  accounts: SocialAccount[];
  error: string;
  onRefresh: () => Promise<void>;
};

/**
 * Postiz reports the platform in `identifier`. Only the five platforms this app generates for have
 * presentation metadata, so anything else falls back to the raw value rather than a maintained list
 * of every platform Postiz supports — that list changes on Postiz's schedule, not ours.
 */
const providerLabel = (identifier: string) => PLATFORM_META[identifier.toLowerCase() as Platform]?.label ?? (identifier || "—").toUpperCase();
const providerAccent = (identifier: string) => PLATFORM_META[identifier.toLowerCase() as Platform]?.accent ?? "#a1a1aa";
const providerMark = (account: SocialAccount) => PLATFORM_META[account.identifier.toLowerCase() as Platform]?.short ?? account.name.slice(0, 1).toUpperCase();

export default function ConnectAccountsDialog({ open, onClose, configured, uiUrl, accounts, error, onRefresh }: Props) {
  const t = useTranslation();
  const [refreshing, setRefreshing] = useState(false);

  if (!open) return null;

  const counts = new Map<string, number>();
  for (const account of accounts) counts.set(account.identifier.toLowerCase(), (counts.get(account.identifier.toLowerCase()) ?? 0) + 1);

  async function refresh() {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="publish-dialog connect-dialog">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">{t("POSTIZ CHANNELS")}</span>
            <h3>{t("Connect social accounts")}</h3>
          </div>
          <span style={{ display: "inline-flex", gap: 4 }}>
            <button type="button" className="icon-button" onClick={() => void refresh()} disabled={refreshing} title={t("Refresh")} aria-label={t("Refresh")}>
              <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label={t("Close")}><X size={18} /></button>
          </span>
        </div>

        <div className="dialog-body">
          <div className="info-banner">
            <AlertTriangle size={18} />
            <div>{t("Platform authorisation happens in Postiz; Polaris never handles platform credentials. Connect there, then press Refresh.")}</div>
          </div>

          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>{t("Platform coverage")}</div>
            <div className="provider-grid">
              {DEFAULT_PLATFORMS.map((platform) => {
                const meta = PLATFORM_META[platform];
                const count = counts.get(platform) ?? 0;
                return (
                  <div key={platform} className={`provider-tile ${count ? "connected" : ""}`}>
                    <span className="provider-icon" style={{ color: meta.accent }}>{meta.icon}</span>
                    <strong>{meta.label}</strong>
                    <small>{count ? `${count} ${t("connected")}` : t("Not connected")}</small>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>{t("Authorised accounts")} ({accounts.length})</div>
            {accounts.length > 0 && (
              <div className="connect-account-list">
                {accounts.map((account) => (
                  <div key={account.id} className={`connect-account-row ${account.disabled ? "off" : ""}`}>
                    <span className="connect-account-mark" style={{ background: providerAccent(account.identifier) }}>{providerMark(account)}</span>
                    <span className="connect-account-name">
                      <strong>{account.name}</strong>
                      <small>{providerLabel(account.identifier)}</small>
                    </span>
                    <span className={`account-state ${account.disabled ? "warn" : "ok"}`}>
                      {account.disabled
                        ? <><AlertTriangle size={12} /> {t("Needs reconnect")}</>
                        : <><CheckCircle2 size={12} /> {t("Ready")}</>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!accounts.length && (
              <div className="info-banner">
                <AlertTriangle size={18} />
                <div>
                  {configured
                    ? t("No authorised accounts yet. Open Postiz, connect a platform, then press Refresh.")
                    : t("Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY.")}
                </div>
              </div>
            )}
            {error && <p className="login-error" role="alert">{error}</p>}
          </div>
        </div>

        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={() => window.open(uiUrl, "_blank", "noreferrer")} disabled={!uiUrl} title={uiUrl ? undefined : t("POSTIZ_UI_URL is not configured on the server.")}>
            <ExternalLink size={14} /> {t("Open Postiz to connect")}
          </button>
          <button type="button" className="primary-button" onClick={onClose}>{t("Done")}</button>
        </div>
      </div>
    </div>
  );
}
