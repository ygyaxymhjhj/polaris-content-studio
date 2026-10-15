"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Bell, Check, FileCheck2, Loader2, LockKeyhole, Send } from "lucide-react";
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
  const [useSignature, setUseSignature] = useState(false);
  const [clearWebhook, setClearWebhook] = useState(false);
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
    setUseSignature(false);
    setClearWebhook(false);
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
      setUseSignature(data.signingConfigured);
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
    || notifyPublished !== settings.notifyPublished || useSignature !== settings.signingConfigured || webhookUrl || signingSecret || clearWebhook));
  const canTest = Boolean(settings?.webhookConfigured && settings.encryptionReady && !dirty && !busy && !loading);
  const needsSigningSecret = useSignature && !clearWebhook && !settings?.signingConfigured;

  async function send(action: "save" | "test") {
    if (!permission.current || busy || loading || !settings?.encryptionReady || (action === "test" && !canTest)) return;
    if (action === "save" && needsSigningSecret && !signingSecret.trim()) {
      setError("A signing secret is required only when signature verification is enabled and no secret is saved.");
      return;
    }
    const signal = requestLifetime.current?.signal;
    setBusy(action);
    setError("");
    setNotice("");
    const body: SettingsPatch | Record<string, never> = action === "test" ? {} : {
      enabled,
      notifyDrafts,
      notifyPublished,
      ...(clearWebhook ? { clearWebhook: true } : webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      ...(!useSignature ? { clearSigningSecret: true } : signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {})
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
    <section className="settings-card settings-card-wide feishu-panel" aria-labelledby="feishu-settings-title" aria-busy={loading || Boolean(busy)}>
      <header className="feishu-header">
        <div className="feishu-heading">
          <span className="feishu-icon"><Bell size={20} aria-hidden="true" /></span>
          <div>
            <h2 id="feishu-settings-title">{t("Feishu group notifications")}</h2>
            <p>{t("Draft reviews and publication updates, delivered to your group.")}</p>
          </div>
        </div>
        {settings && <label className="feishu-master-toggle feishu-switch">
          <span>{t(enabled ? "Notifications on" : "Notifications off")}</span>
          <input type="checkbox" checked={enabled} disabled={Boolean(busy) || loading} onChange={event => setEnabled(event.target.checked)} />
          <span className="feishu-switch-track" aria-hidden="true" />
        </label>}
      </header>
      {loading && <p className="feishu-feedback" role="status">{t("Loading Feishu settings...")}</p>}
      {settings && (
        <>
          {!settings.encryptionReady && <p className="feishu-feedback feishu-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{t("Configure FEISHU_ENCRYPTION_KEY on the server to save credentials.")}</p>}
          <form onSubmit={saveSettings} aria-describedby="feishu-sharing-warning">
            <fieldset className="feishu-fieldset" disabled={Boolean(busy) || loading}>
              <legend className="feishu-sr-only">{t("Notification preferences")}</legend>
              <div className="feishu-columns">
                <section className="feishu-events" aria-labelledby="feishu-events-title">
                  <h3 id="feishu-events-title">{t("Notification events")}</h3>
                  <label className="feishu-event">
                    <FileCheck2 size={20} aria-hidden="true" />
                    <span className="feishu-event-copy"><strong>{t("Draft review")}</strong><span>{t("When someone submits a draft")}</span></span>
                    <input className="feishu-checkbox" type="checkbox" checked={notifyDrafts} onChange={event => setNotifyDrafts(event.target.checked)} />
                    <span className="feishu-checkmark" aria-hidden="true"><Check size={13} /></span>
                  </label>
                  <label className="feishu-event">
                    <Send size={20} aria-hidden="true" />
                    <span className="feishu-event-copy"><strong>{t("Post published")}</strong><span>{t("After publication is confirmed")}</span></span>
                    <input className="feishu-checkbox" type="checkbox" checked={notifyPublished} onChange={event => setNotifyPublished(event.target.checked)} />
                    <span className="feishu-checkmark" aria-hidden="true"><Check size={13} /></span>
                  </label>
                  <p className="feishu-sharing" id="feishu-sharing-warning">{t("Workspace updates will be sent to this group.")}</p>
                </section>
                <section className="feishu-connection" aria-labelledby="feishu-connection-title">
                  <div className="feishu-section-heading">
                    <h3 id="feishu-connection-title">{t("Bot connection")}</h3>
                    <span className="feishu-badge">{settings.webhookConfigured && <Check size={12} aria-hidden="true" />}{t(settings.webhookConfigured ? "Webhook saved" : "Not connected")}</span>
                  </div>
                  <label className="feishu-field" htmlFor="feishu-webhook">{t("Webhook URL")}
                    <input className={clearWebhook ? "feishu-input feishu-input-removing" : "feishu-input"} id="feishu-webhook" type="password" autoComplete="new-password" spellCheck={false} placeholder={t(settings.webhookConfigured ? "Saved; enter a replacement" : "Paste your bot webhook URL")} value={webhookUrl} disabled={clearWebhook} onChange={event => setWebhookUrl(event.target.value)} />
                  </label>
                  <label className="feishu-remove">
                    <input className="feishu-checkbox" type="checkbox" checked={clearWebhook} onChange={event => { setClearWebhook(event.target.checked); if (event.target.checked) setWebhookUrl(""); }} />
                    <span className="feishu-checkmark" aria-hidden="true"><Check size={13} /></span>
                    <span>{t("Remove connection")}</span>
                  </label>
                  <label className="feishu-signature feishu-switch">
                    <span>{t("Signature verification")} <span className="feishu-optional">{t("Optional")}</span></span>
                    <input type="checkbox" checked={useSignature} onChange={event => { setUseSignature(event.target.checked); if (!event.target.checked) setSigningSecret(""); }} />
                    <span className="feishu-switch-track" aria-hidden="true" />
                  </label>
                  <label className="feishu-field feishu-secret" htmlFor="feishu-signing-secret" hidden={!useSignature}>{t("Signing secret")}
                    <input className="feishu-input" id="feishu-signing-secret" type="password" autoComplete="new-password" spellCheck={false} placeholder={t(settings.signingConfigured ? "Saved; enter a replacement" : "Enter signing secret")} value={signingSecret} disabled={!useSignature || clearWebhook} required={needsSigningSecret} onChange={event => setSigningSecret(event.target.value)} />
                  </label>
                  {settings.encryptionReady && <span className="feishu-encryption"><LockKeyhole size={13} aria-hidden="true" />{t("Credentials encrypted")}</span>}
                </section>
              </div>
              <footer className="feishu-actions">
                <div className="feishu-save-state">
                  <span className={dirty ? "feishu-dirty-dot" : "feishu-saved-icon"} aria-hidden="true">{!dirty && <Check size={14} />}</span>
                  <span>{t(dirty ? "Unsaved changes" : "All changes saved")}</span>
                </div>
                <div className="feishu-buttons">
                  <button className="secondary-button" type="button" aria-label={t("Send test message")} disabled={!canTest} aria-describedby={dirty || !settings.webhookConfigured ? "feishu-test-help" : undefined} onClick={() => void send("test")}>{busy === "test" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}{t("Send test message")}</button>
                  <button className="primary-button" type="submit" disabled={!settings.encryptionReady || !dirty}>{busy === "save" && <Loader2 size={14} className="spin" aria-hidden="true" />}{t("Save changes")}</button>
                </div>
                {(dirty || !settings.webhookConfigured) && <p className="feishu-test-help" id="feishu-test-help">{t(dirty ? "Save your changes to test." : "Add a webhook to test.")}</p>}
              </footer>
            </fieldset>
          </form>
          <dl className="feishu-metadata">
            <div><dt>{t("Configuration updated")} <span className="feishu-version">v{settings.version}</span></dt><dd>{displayTime(settings.updatedAt)}</dd></div>
            <div><dt>{t("Last test")}</dt><dd>{settings.lastTestAt ? <>{displayTime(settings.lastTestAt)} · {t(settings.lastTestOk === true ? "Successful" : settings.lastTestOk === false ? "Failed" : "Not tested")}</> : t("Not tested")}</dd></div>
            <div><dt>{t("Last worker update")}</dt><dd>{displayTime(settings.lastWorkerAt)}</dd></div>
          </dl>
          {settings.lastTestError && <p className="feishu-feedback feishu-error">{t("Last test error")}: {redactError(settings.lastTestError)}</p>}
          {settings.lastDeliveryError && <p className="feishu-feedback feishu-error">{t("Last delivery error (redacted)")}: {redactError(settings.lastDeliveryError)}</p>}
        </>
      )}
      {notice && <p className="feishu-feedback" role="status">{t(notice)}</p>}
      {error && <p className="feishu-feedback feishu-error" role="alert">{t(error)}</p>}
      {!loading && !settings && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void loadSettings(requestLifetime.current?.signal)}>{t("Retry")}</button>}
    </section>
  );
}
