"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { SOCIAL_PLATFORM_META as PLATFORM_META, type SocialPlatform as Platform, type SocialAccount } from "@/lib/types";

type AssignableMember = { id: string; displayName: string; disabled: boolean };

type Props = {
  accounts: SocialAccount[];
  configured: boolean;
  uiUrl: string;
  loading: boolean;
  error: string;
  notice: string;
  syncedAt: string;
  isAdmin: boolean;
  onAddAccount: () => void;
  onRefresh: () => Promise<void>;
};

export default function SocialAccountsView({ accounts, configured, uiUrl, loading, error, notice, syncedAt, isAdmin, onAddAccount, onRefresh }: Props) {
  const translate = useTranslation();
  const readyCount = accounts.filter(account => !account.disabled).length;
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [assigningId, setAssigningId] = useState("");
  const assignmentFlight = useRef(false);
  const [pending, setPending] = useState<{ integrationId: string; userIds: string[] } | null>(null);
  const [assignError, setAssignError] = useState("");

  // The member list only feeds the administrator's assignment checkboxes; /api/auth/users is itself
  // administrator-gated, so a failed load pauses assignment instead of offering an empty list.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch("/api/auth/users", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("member list unavailable");
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const users: Array<{ id?: unknown; displayName?: unknown; disabled?: unknown }> = Array.isArray(data?.users) ? data.users : [];
        setMembers(users
          .filter((member) => typeof member.id === "string" && typeof member.displayName === "string")
          .map((member) => ({ id: member.id as string, displayName: member.displayName as string, disabled: Boolean(member.disabled) })));
        setMembersError(false);
        setMembersLoaded(true);
      })
      .catch(() => { if (!cancelled) { setMembers([]); setMembersError(true); setMembersLoaded(true); } });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const assignedUsers = (account: SocialAccount) => account.assignedUsers ?? [];
  const assignedIds = (account: SocialAccount) => pending?.integrationId === account.id
    ? pending.userIds
    : assignedUsers(account).map((user) => user.id);

  const saveAssignments = useCallback(async (integrationId: string, userIds: string[]) => {
    if (assignmentFlight.current || membersError) return;
    assignmentFlight.current = true;
    setAssigningId(integrationId);
    setPending({ integrationId, userIds });
    setAssignError("");
    try {
      const response = await fetch(`/api/social/accounts/${encodeURIComponent(integrationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not update the account assignment.");
      await onRefresh();
    } catch (assignmentFailure) {
      setAssignError(assignmentFailure instanceof Error ? assignmentFailure.message : "Could not update the account assignment.");
    } finally {
      assignmentFlight.current = false;
      setPending(null);
      setAssigningId("");
    }
  }, [membersError, onRefresh]);

  const toggleAssignment = (account: SocialAccount, memberId: string) => {
    if (assignmentFlight.current) return;
    const current = assignedIds(account);
    void saveAssignments(account.id, current.includes(memberId) ? current.filter(id => id !== memberId) : [...current, memberId]);
  };

  return (
    <section className="social-accounts-view" aria-labelledby="social-accounts-title">
      <div className="page-heading compact-heading accounts-heading">
        <div>
          <div className="eyebrow">{translate("ACCOUNT CONNECTIONS")}</div>
          <h1 id="social-accounts-title">{translate("Social accounts")}</h1>
          <p>{translate(isAdmin
            ? "Manage accounts and member assignments."
            : "Manage your connected accounts.")}</p>
        </div>
        <button type="button" className="primary-button" onClick={onAddAccount}><Plus size={16} /> {translate("Add social account")}</button>
      </div>

      {notice && <p className="connection-notice" role="status">{translate(notice)}</p>}
      {!loading && !configured && !accounts.length && <div className="info-banner" role="status"><AlertTriangle size={18} /><div>{translate("Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY.")}</div></div>}

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
                const assigned = assignedUsers(account);
                return (
                  <li key={account.id} className={`accounts-directory-row ${isAdmin && !assigned.length ? "unassigned" : ""}`}>
                    <span className="accounts-platform-mark">{metadata?.short || account.identifier.slice(0, 2).toUpperCase() || "?"}</span>
                    <div className="accounts-directory-identity"><strong>{account.name}</strong><span>{metadata?.label || account.identifier}</span></div>
                    {isAdmin && (
                      <details className="account-owner-control">
                        <summary aria-label={`${translate("Assign account")}: ${account.name}`}>
                          {assigned.length
                            ? `${translate("Assigned to")}: ${assigned.map(user => user.name).join(", ")}`
                            : translate("Unassigned")}
                        </summary>
                        <div className="account-assignment-menu">
                          {membersError ? (
                            <span className="account-assignment-empty">{translate("The member list is unavailable. Assignment is paused.")}</span>
                          ) : (
                            <>
                              {members
                                .filter(member => !member.disabled || assignedIds(account).includes(member.id))
                                .map(member => (
                                  <label key={member.id} className="account-assignment-option">
                                    <input type="checkbox" checked={assignedIds(account).includes(member.id)}
                                      disabled={Boolean(assigningId)}
                                      onChange={() => toggleAssignment(account, member.id)} />
                                    <span>{member.displayName}{member.disabled ? ` (${translate("Disabled")})` : ""}</span>
                                  </label>
                                ))}
                              {!members.length && membersLoaded && <span className="account-assignment-empty">{translate("No members available")}</span>}
                            </>
                          )}
                        </div>
                      </details>
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
          <div className="accounts-list-footer">
            <span className={`accounts-service-dot ${error || !configured ? "unavailable" : ""}`} />
            <span>{translate(error ? "Postiz connection unavailable" : configured ? "Connected to Postiz" : "Postiz configuration required")}</span>
            {syncedAt && <span>{translate("Last refreshed")}: {new Date(syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
            {isAdmin && uiUrl && <a className="text-button" href={uiUrl} target="_blank" rel="noopener noreferrer">{translate("Open Postiz")} <ExternalLink size={13} /></a>}
          </div>
        </section>
      </div>
    </section>
  );
}
