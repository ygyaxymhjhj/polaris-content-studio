"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, UserPlus, Users } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

type Member = { id: string; username: string; displayName: string; role: "admin" | "member"; disabled: boolean; createdAt: string };

export default function MembersPanel({ canManageMembers }: { canManageMembers: boolean }) {
  const t = useTranslation();
  const [members, setMembers] = useState<Member[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  // These hold message keys or server text; translation happens at render. Keeping `t` out of the
  // fetch callbacks matters: useTranslation returns a new function every render, so depending on it
  // would re-create `load`, re-fire the effect, set state, and loop forever.
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ username: "", displayName: "", password: "" });
  const [resetFor, setResetFor] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const hasPermission = canManageMembers === true && !accessDenied;

  const revokeAccess = useCallback(() => {
    setAccessDenied(true);
    setMembers([]);
    setCurrentUserId("");
    setDraft({ username: "", displayName: "", password: "" });
    setResetFor("");
    setNewPassword("");
    setError("");
    setNotice("");
  }, []);

  const load = useCallback(async () => {
    if (!hasPermission) return false;
    try {
      const response = await fetch("/api/auth/users", { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        revokeAccess();
        return false;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "Could not load members."); return false; }
      setMembers(data.users);
      setCurrentUserId(data.currentUserId);
      setError("");
      return true;
    } catch {
      setError("Could not load members.");
      return false;
    }
  }, [hasPermission, revokeAccess]);

  useEffect(() => { void load(); }, [load]);

  async function send(method: "POST" | "PATCH", body: unknown) {
    if (!hasPermission || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/auth/users", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401 || response.status === 403) {
        revokeAccess();
        return false;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "Could not update the account."); return false; }
      return await load();
    } catch {
      setError("Could not update the account.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (await send("POST", draft)) {
      setDraft({ username: "", displayName: "", password: "" });
      setNotice("Member created. Share the password with them directly.");
    }
  }

  async function update(member: Member, action: "password" | "disable" | "enable", password?: string) {
    if (await send("PATCH", { id: member.id, action, password })) {
      setResetFor("");
      setNewPassword("");
      setNotice(
        action === "password" ? "Password updated. That account's other sessions were signed out."
          : action === "disable" ? "Member disabled and signed out."
            : "Member re-enabled."
      );
    }
  }

  async function changeRole(member: Member) {
    if (!window.confirm(t("Change this member's role? They will need to sign in again."))) return;
    const role = member.role === "admin" ? "member" : "admin";
    if (await send("PATCH", { id: member.id, action: "set-role", role })) {
      setResetFor("");
      setNewPassword("");
      setNotice("Member role saved.");
    }
  }

  if (!hasPermission) return null;

  return (
    <div className="settings-card settings-card-wide">
      <div className="settings-card-icon"><Users size={18} /></div>
      <h2>{t("Members")}</h2>

      <div className="member-list">
        {members.map((member) => {
          const isSelf = member.id === currentUserId;
          const isBootstrap = member.username === "admin";
          return (
            <div key={member.id}>
              <div className="member-row">
                <span className="member-identity">
                  <strong>{member.displayName}</strong>
                  <small>{member.username} · {t(member.role === "admin" ? "Administrator" : "Member")}{isSelf && ` · ${t("You")}`}</small>
                </span>
                <span className={`member-status ${member.disabled ? "off" : "on"}`}>{member.disabled ? t("Disabled") : t("Active")}</span>
                <span className="member-actions">
                  <button type="button" className="small-button" onClick={() => { setResetFor(resetFor === member.id ? "" : member.id); setNewPassword(""); }}>{t("Reset password")}</button>
                  <button type="button" className="small-button" disabled={busy || (!member.disabled && (isSelf || isBootstrap))} onClick={() => void update(member, member.disabled ? "enable" : "disable")}>
                    {member.disabled ? t("Enable") : t("Disable")}
                  </button>
                  {!isSelf && !(isBootstrap && member.role === "admin") && (
                    <button type="button" className="small-button" disabled={busy} onClick={() => void changeRole(member)}>
                      {t(member.role === "admin" ? "Make member" : "Make administrator")}
                    </button>
                  )}
                </span>
              </div>
              {resetFor === member.id && (
                <div className="member-reset">
                  <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={t("New password (at least 8 characters)")} />
                  <button type="button" className="small-button" disabled={busy || newPassword.length < 8} onClick={() => void update(member, "password", newPassword)}>{t("Save password")}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <form className="member-create" onSubmit={create}>
        <input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder={t("Username")} autoComplete="off" required />
        <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder={t("Display name")} autoComplete="off" required />
        <input value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder={t("Initial password (at least 8 characters)")} autoComplete="off" required />
        <button type="submit" className="small-button" disabled={busy || draft.password.length < 8}>
          {busy ? <Loader2 size={13} className="spin" /> : <UserPlus size={13} />} {t("Add member")}
        </button>
      </form>

      {notice && <p className="members-notice" role="status">{t(notice)}</p>}
      {error && <p className="login-error" role="alert">{t(error)}</p>}
    </div>
  );
}
