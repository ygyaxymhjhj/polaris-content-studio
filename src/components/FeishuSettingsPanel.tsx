"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface FeishuSettings {
  enabled: boolean;
  notifyDrafts: boolean;
  notifyPublished: boolean;
  webhookConfigured: boolean;
  signingConfigured: boolean;
  encryptionReady: boolean;
  version: number;
  updatedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastWorkerAt: string | null;
  lastDeliveryError: string | null;
}

interface SettingsPatch {
  enabled: boolean;
  notifyDrafts: boolean;
  notifyPublished: boolean;
  webhookUrl?: string;
  signingSecret?: string;
  clearWebhook?: boolean;
  clearSigningSecret?: boolean;
}

function isSettings(value: unknown): value is FeishuSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  const booleanFields = ["enabled", "notifyDrafts", "notifyPublished", "webhookConfigured", "signingConfigured", "encryptionReady"];
  const nullableTextFields = ["updatedAt", "lastTestAt", "lastTestError", "lastWorkerAt", "lastDeliveryError"];
  return booleanFields.every(field => typeof settings[field] === "boolean")
    && typeof settings.version === "number"
    && nullableTextFields.every(field => settings[field] === null || typeof settings[field] === "string")
    && (settings.lastTestOk === null || typeof settings.lastTestOk === "boolean");
}

// The API supplies safe errors; redact URLs and newly entered credentials defensively as well.
function redactError(message: string, credentials: string[] = []) {
  let redacted = message;
  for (const credential of credentials) {
    if (credential) redacted = redacted.split(credential).join("[redacted]");
  }
  return redacted.replace(/https?:\/\/[^\s<>"']+/gi, "[redacted]").slice(0, 500);
}

export default function FeishuSettingsPanel({ canManageMembers }: { canManageMembers: boolean }) {
  const t = useTranslation();
  const [settings, setSettings] = useState<FeishuSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [notifyDrafts, setNotifyDrafts] = useState(false);
  const [notifyPublished, setNotifyPublished] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [clearWebhook, setClearWebhook] = useState(false);
  const [clearSigningSecret, setClearSigningSecret] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const hasPermission = canManageMembers === true && !accessDenied;
  const permission = useRef(hasPermission);
  const requestLifetime = useRef<AbortController | null>(null);
  permission.current = hasPermission;

  const clearCredentials = useCallback(() => {
    setWebhookUrl("");
    setSigningSecret("");
    setClearWebhook(false);
    setClearSigningSecret(false);
  }, []);

  const revokeAccess = useCallback(() => {
    permission.current = false;
    requestLifetime.current?.abort();
    setAccessDenied(true);
    setSettings(null);
    clearCredentials();
    setError("");
    setNotice("");
  }, [clearCredentials]);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    if (!permission.current) return false;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/feishu", { cache: "no-store", signal });
      if (signal?.aborted || !permission.current) return false;
      if (response.status === 401 || response.status === 403) {
        revokeAccess();
        return false;
      }
      const data: unknown = await response.json().catch(() => null);
      if (signal?.aborted || !permission.current) return false;
      // Deliberately accept the agreed direct object, never a guessed { settings } envelope.
      if (!response.ok || !isSettings(data)) {
        setError("Could not load Feishu settings. Refresh and try again.");
        return false;
      }
      setSettings(data);
      setEnabled(data.enabled);
      setNotifyDrafts(data.notifyDrafts);
      setNotifyPublished(data.notifyPublished);
      setError("");
      return true;
    } catch {
      if (!signal?.aborted && permission.current) setError("Could not load Feishu settings. Refresh and try again.");
      return false;
    } finally {
      if (!signal?.aborted && permission.current) setLoading(false);
    }
  }, [revokeAccess]);

  useEffect(() => {
    const controller = new AbortController();
    requestLifetime.current = controller;
    permission.current = hasPermission;
    if (hasPermission) void loadSettings(controller.signal);
    else {
      clearCredentials();
      setSettings(null);
      setBusy(null);
      setError("");
      setNotice("");
    }
    return () => {
      controller.abort();
      permission.current = false;
    };
  }, [hasPermission, loadSettings, clearCredentials]);

  const dirty = Boolean(settings && (enabled !== settings.enabled || notifyDrafts !== settings.notifyDrafts
    || notifyPublished !== settings.notifyPublished || webhookUrl || signingSecret || clearWebhook || clearSigningSecret));
  const canTest = Boolean(settings?.webhookConfigured && settings.encryptionReady && !dirty && !busy && !loading);

  async function send(action: "save" | "test") {
    if (!permission.current || busy || loading || !settings?.encryptionReady || (action === "test" && !canTest)) return;
    const signal = requestLifetime.current?.signal;
    setBusy(action);
    setError("");
    setNotice("");
    const body: SettingsPatch | Record<string, never> = action === "test" ? {} : {
      enabled,
      notifyDrafts,
      notifyPublished,
      ...(clearWebhook ? { clearWebhook: true } : webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      ...(clearSigningSecret ? { clearSigningSecret: true } : signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {})
    };
    try {
      const response = await fetch(action === "test" ? "/api/admin/feishu/test" : "/api/admin/feishu", {
        method: action === "test" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      if (signal?.aborted || !permission.current) return;
      if (response.status === 401 || response.status === 403) {
        revokeAccess();
        return;
      }
      // Clear credentials immediately after a successful save, even if the subsequent read fails.
      if (response.ok && action === "save") {
        clearCredentials();
        setSettings(null);
      }
      const data = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (signal?.aborted || !permission.current) return;
      if (!response.ok || (action === "test" && data?.success !== true)) {
        const fallback = response.status === 429 ? "Too many Feishu tests. Wait before trying again."
          : action === "test" ? "Feishu test failed. Check the saved configuration." : "Could not save Feishu settings.";
        const safeError = typeof data?.error === "string" ? redactError(data.error, [webhookUrl.trim(), signingSecret.trim()]) : fallback;
        if (action === "test") await loadSettings(signal);
        if (!signal?.aborted && permission.current) setError(safeError);
        return;
      }
      setNotice(action === "test" ? "Feishu test message sent using the saved configuration." : "Feishu settings saved.");
      await loadSettings(signal);
    } catch {
      if (!signal?.aborted && permission.current) setError(action === "test" ? "Feishu test failed. Check the saved configuration." : "Could not save Feishu settings.");
    } finally {
      if (!signal?.aborted && permission.current) setBusy(null);
    }
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send("save");
  }

  if (!hasPermission) return null;

  const displayTime = (value: string | null) => value ? (Number.isNaN(Date.parse(value)) ? t("Unknown") : new Date(value).toLocaleString()) : t("Never");
  return (
    <section className="settings-card settings-card-wide" aria-labelledby="feishu-settings-title" aria-busy={loading || Boolean(busy)}>
      <div className="settings-card-icon"><Bell size={18} aria-hidden="true" /></div>
      <h2 id="feishu-settings-title">{t("Feishu group notifications")}</h2>
      <p className="members-intro" id="feishu-sharing-warning">{t("The shared group receives submission summaries from all members. Confirm that everyone in the group may see them. Messages do not mention @all by default.")}</p>
      {loading && <p role="status">{t("Loading Feishu settings...")}</p>}
      {settings && (
        <>
          <div role="status" style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
            <span>{t("Webhook")}: <strong>{t(settings.webhookConfigured ? "Configured" : "Not configured")}</strong></span>
            <span>{t("Signing secret")}: <strong>{t(settings.signingConfigured ? "Configured" : "Not configured")}</strong></span>
            <span>{t("Encryption")}: <strong>{t(settings.encryptionReady ? "Ready" : "Not ready")}</strong></span>
          </div>
          {!settings.encryptionReady && <p className="login-error" role="alert">{t("Saving is disabled until the server administrator configures FEISHU_ENCRYPTION_KEY. Never enter this environment key here.")}</p>}
          <form onSubmit={saveSettings} aria-describedby="feishu-sharing-warning">
            <fieldset disabled={Boolean(busy) || loading} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14, minWidth: 0 }}>
              <legend className="field-label">{t("Notification preferences")}</legend>
              <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> {t("Enable Feishu notifications")}</label>
              <label><input type="checkbox" checked={notifyDrafts} onChange={event => setNotifyDrafts(event.target.checked)} /> {t("Notify when a draft is submitted")}</label>
              <label><input type="checkbox" checked={notifyPublished} onChange={event => setNotifyPublished(event.target.checked)} /> {t("Notify when a post is published")}</label>
              <p id="feishu-credentials-help">{t("Existing credentials are never displayed. Leave a field blank to keep its saved value. Use the separate clear checkboxes to remove credentials.")}</p>
              <label className="field-label" htmlFor="feishu-webhook">{t("New webhook URL")}
                <input id="feishu-webhook" type="password" autoComplete="new-password" spellCheck={false} value={webhookUrl} disabled={clearWebhook} aria-describedby="feishu-credentials-help" onChange={event => setWebhookUrl(event.target.value)} style={{ width: "100%" }} />
              </label>
              <label><input type="checkbox" checked={clearWebhook} onChange={event => { setClearWebhook(event.target.checked); if (event.target.checked) setWebhookUrl(""); }} /> {t("Clear the saved webhook URL")}</label>
              <label className="field-label" htmlFor="feishu-signing-secret">{t("New signing secret")}
                <input id="feishu-signing-secret" type="password" autoComplete="new-password" spellCheck={false} value={signingSecret} disabled={clearSigningSecret} aria-describedby="feishu-credentials-help" onChange={event => setSigningSecret(event.target.value)} style={{ width: "100%" }} />
              </label>
              <label><input type="checkbox" checked={clearSigningSecret} onChange={event => { setClearSigningSecret(event.target.checked); if (event.target.checked) setSigningSecret(""); }} /> {t("Clear the saved signing secret")}</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                <button className="primary-button" type="submit" disabled={!settings.encryptionReady || !dirty}>{busy === "save" && <Loader2 size={14} className="spin" aria-hidden="true" />} {t("Save Feishu settings")}</button>
                <button className="secondary-button" type="button" disabled={!canTest} aria-describedby="feishu-test-help" onClick={() => void send("test")}>{busy === "test" && <Loader2 size={14} className="spin" aria-hidden="true" />} {t("Send test message")}</button>
              </div>
              <p id="feishu-test-help">{t(dirty ? "Save your changes before testing. Only the saved configuration is tested." : !settings.webhookConfigured ? "Save a webhook URL before sending a test message." : "Testing sends a real message to the saved group, even when automatic notifications are disabled.")}</p>
            </fieldset>
          </form>
          <dl style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(0, 2fr)", gap: 10, marginTop: 20, fontSize: 12 }}>
            <dt>{t("Configuration updated")}</dt><dd style={{ margin: 0 }}>{displayTime(settings.updatedAt)} ({t("Version")} {settings.version})</dd>
            <dt>{t("Last test")}</dt><dd style={{ margin: 0 }}>{displayTime(settings.lastTestAt)} / {t(settings.lastTestOk === true ? "Successful" : settings.lastTestOk === false ? "Failed" : "Not tested")}</dd>
            <dt>{t("Last worker update")}</dt><dd style={{ margin: 0 }}>{displayTime(settings.lastWorkerAt)}</dd>
          </dl>
          {settings.lastTestError && <p className="login-error">{t("Last test error")}: {redactError(settings.lastTestError)}</p>}
          {settings.lastDeliveryError && <p className="login-error">{t("Last delivery error (redacted)")}: {redactError(settings.lastDeliveryError)}</p>}
        </>
      )}
      {notice && <p className="members-notice" role="status">{t(notice)}</p>}
      {error && <p className="login-error" role="alert">{t(error)}</p>}
      {!loading && !settings && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void loadSettings(requestLifetime.current?.signal)}>{t("Retry")}</button>}
    </section>
  );
}
