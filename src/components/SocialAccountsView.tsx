"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";

type AssignableMember = { id: string; displayName: string };

type Props = {
  accounts: SocialAccount[];
  configured: boolean;
  oauthConfigured: boolean;
  uiUrl: string;
  loading: boolean;
  error: string;
  notice: string;
  syncedAt: string;
  isAdmin: boolean;
  onAddAccount: () => void;
  onRefresh: () => Promise<void>;
};

export default function SocialAccountsView({ accounts, configured, oauthConfigured, uiUrl, loading, error, notice, syncedAt, isAdmin, onAddAccount, onRefresh }: Props) {
  const translate = useTranslation();
  const readyCount = accounts.filter(account => !account.disabled).length;
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [assigningId, setAssigningId] = useState("");
  const [assignError, setAssignError] = useState("");

  // The member list only feeds the administrator's assignment dropdown; /api/auth/users is itself
  // administrator-gated, so a failed load simply leaves the dropdown with only "Unassigned".
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch("/api/auth/users", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { users: [] }))
      .then((data) => {
        if (cancelled) return;
        const users: Array<{ id?: unknown; displayName?: unknown; disabled?: unknown }> = Array.isArray(data?.users) ? data.users : [];
        setMembers(users
          .filter((member) => !member.disabled && typeof member.id === "string" && typeof member.displayName === "string")
          .map((member) => ({ id: member.id as string, displayName: member.displayName as string })));
      })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const assignOwner = useCallback(async (integrationId: string, ownerUserId: string | null) => {
    if (assigningId) return;
    setAssigningId(integrationId);
    setAssignError("");
    try {
      const response = await fetch(`/api/social/accounts/${encodeURIComponent(integrationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerUserId })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not update the account assignment.");
      await onRefresh();
    } catch (assignmentFailure) {
      setAssignError(assignmentFailure instanceof Error ? assignmentFailure.message : "Could not update the account assignment.");
    } finally {
      setAssigningId("");
    }
  }, [assigningId, onRefresh]);

  return (
    <section className="social-accounts-view" aria-labelledby="social-accounts-title">
      <div className="page-heading compact-heading accounts-heading">
        <div>
          <div className="eyebrow">{translate("ACCOUNT CONNECTIONS")}</div>
          <h1 id="social-accounts-title">{translate("Social accounts")}</h1>
          <p>{translate(isAdmin
            ? "Every workspace account is listed here. Assign channels to members so they can view and publish to them."
            : "Only accounts you authorised or an administrator assigned to you are shown. Publishing uses your own accounts only.")}</p>
        </div>
        <button type="button" className="primary-button" onClick={onAddAccount}><Plus size={16} /> {translate("Add social account")}</button>
      </div>

      {notice && <p className="connection-notice" role="status">{translate(notice)}</p>}
      {!loading && !configured && <div className="info-banner" role="status"><AlertTriangle size={18} /><div>{translate("Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY.")}</div></div>}

      <div className="accounts-layout">
        <section className="panel accounts-panel" aria-labelledby="authorised-accounts-title" aria-busy={loading}>
          <div className="accounts-list-header">
            <div><h2 id="authorised-accounts-title">{translate("Authorised accounts")}</h2><p>{accounts.length} {translate("connected")} / {readyCount} {translate("Ready")}</p></div>
            <button type="button" className="secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : undefined} /> {translate("Refresh accounts")}</button>
          </div>
          {error && <div className="accounts-error" role="alert"><AlertTriangle size={16} /><span>{translate(error)}</span></div>}
          {assignError && <div className="accounts-error" role="alert"><AlertTriangle size={16} /><span>{translate(assignError)}</span></div>}

          {loading && !accounts.length ? (
            <div className="accounts-loading" role="status"><div className="account-skeleton" /><div className="account-skeleton" /><span>{translate("Loading accounts...")}</span></div>
          ) : accounts.length ? (
            <ul className="accounts-directory">
              {accounts.map(account => {
                const metadata = PLATFORM_META[account.identifier.toLowerCase() as Platform];
                return (
                  <li key={account.id} className={`accounts-directory-row ${isAdmin && !account.ownerUserId ? "unassigned" : ""}`}>
                    <span className="accounts-platform-mark">{metadata?.short || account.identifier.slice(0, 2).toUpperCase() || "?"}</span>
                    <div className="accounts-directory-identity"><strong>{account.name}</strong><span>{metadata?.label || account.identifier}</span></div>
                    {isAdmin && (
                      <label className="account-owner-control">
                        <span>{translate(account.ownerUserId ? "Assigned to" : "Unassigned")}</span>
                        <select
                          value={account.ownerUserId ?? ""}
                          disabled={assigningId === account.id}
                          onChange={(event) => void assignOwner(account.id, event.target.value || null)}
                          aria-label={`${translate("Assign account")}: ${account.name}`}
                        >
                          <option value="">{translate("Unassigned")}</option>
                          {members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                        </select>
                      </label>
                    )}
                    <span className={`account-state ${account.disabled ? "warn" : "ok"}`}>
                      {account.disabled ? <><AlertTriangle size={13} /> {translate("Needs reconnect")}</> : <><CheckCircle2 size={13} /> {translate("Ready")}</>}
                    </span>
                    {account.disabled && isAdmin && uiUrl && <a className="text-button" href={uiUrl} target="_blank" rel="noopener noreferrer">{translate("Reconnect in Postiz")} <ExternalLink size={13} /></a>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="accounts-empty">
              <span className="accounts-empty-mark"><Link2 size={24} /></span>
              <h3>{translate(error ? "Account list unavailable" : "Your first account starts here")}</h3>
              <p>{translate(error ? "Refresh to retry. Previously connected accounts have not been disconnected." : "Choose a platform and authorise it through Postiz. No social passwords are stored here.")}</p>
              {!error && !isAdmin && <p>{translate("Missing an account? Ask an administrator to assign it to you.")}</p>}
              {!error && <button type="button" className="secondary-button" onClick={onAddAccount}><Plus size={14} /> {translate("Add social account")}</button>}
            </div>
          )}
          <div className="accounts-list-footer"><span className={`accounts-service-dot ${error || !configured ? "unavailable" : ""}`} /> {translate(error ? "Postiz connection unavailable" : configured ? "Connected to Postiz" : "Postiz configuration required")}{syncedAt && <span>{translate("Last refreshed")}: {new Date(syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}</div>
        </section>

        <aside className="accounts-guide" aria-label={translate("How connection works")}>
          <div className="eyebrow">{translate("HOW IT WORKS")}</div>
          <ol>
            <li><span>01</span><div><strong>{translate("Choose a platform")}</strong><p>{translate("Facebook, Instagram, X, Threads or LinkedIn.")}</p></div></li>
            <li><span>02</span><div><strong>{translate("Approve access")}</strong><p>{translate("Sign in on the platform's official page. Postiz handles authorisation and token refresh.")}</p></div></li>
            <li><span>03</span><div><strong>{translate("Return and publish")}</strong><p>{translate("The account list refreshes when you return. Select the account in the publish dialog.")}</p></div></li>
          </ol>
          <div className="accounts-trust-note"><ShieldCheck size={18} /><p>{translate("Only the owner and workspace administrators can see and use an account.")}</p></div>
          {!loading && !oauthConfigured && <p className="accounts-config-note">{translate("Direct authorisation needs the Postiz JWT secret. You can still connect from Postiz and refresh this list.")}</p>}
          {isAdmin && uiUrl && <a className="text-button" href={uiUrl} target="_blank" rel="noopener noreferrer">{translate("Open Postiz")} <ExternalLink size={13} /></a>}
        </aside>
      </div>
    </section>
  );
}
