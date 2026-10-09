"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, ExternalLink, Loader2, ShieldCheck, X as CloseIcon } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { DEFAULT_PLATFORMS, PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  configured: boolean;
  oauthConfigured: boolean;
  loading: boolean;
  uiUrl: string;
  accounts: SocialAccount[];
  error: string;
  onRefresh: () => Promise<void>;
};

export default function ConnectAccountsDialog({ open, onClose, configured, oauthConfigured, loading, uiUrl, accounts, error, onRefresh }: Props) {
  const translate = useTranslation();
  const [provider, setProvider] = useState<Platform>("x");
  const [creatingLink, setCreatingLink] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const authorizationWindow = useRef<Window | null>(null);
  const dialogElement = useRef<HTMLDivElement>(null);
  const closeHandler = useRef(onClose);
  useEffect(() => { closeHandler.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogElement.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") closeHandler.current();
      if (event.key !== "Tab") return;
      const focusableElements = dialogElement.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]");
      if (!focusableElements?.length) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) { event.preventDefault(); lastElement.focus(); }
      if (!event.shiftKey && document.activeElement === lastElement) { event.preventDefault(); firstElement.focus(); }
    }
    document.addEventListener("keydown", handleKeyboard);
    return () => { document.removeEventListener("keydown", handleKeyboard); previousFocus?.focus(); };
  }, [open]);

  useEffect(() => {
    function handleReturn(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== authorizationWindow.current || event.data?.type !== "POLARIS_POSTIZ_RETURNED") return;
      authorizationWindow.current = null;
      setAuthorizing(false);
      if (event.data.outcome === "returned") {
        setNotice("Authorisation returned. Check the refreshed account list; if an account is missing, finish selecting its page in Postiz.");
        setConnectionError("");
      } else {
        setConnectionError("The authorisation return expired or belongs to another session. Please start again.");
      }
      void onRefresh();
    }
    function handleFocus() {
      if (authorizationWindow.current) void onRefresh();
    }
    const interval = window.setInterval(() => {
      if (!authorizationWindow.current?.closed) return;
      authorizationWindow.current = null;
      setAuthorizing(false);
      setNotice("The authorisation window closed. Check the refreshed account list or try connecting again.");
      void onRefresh();
    }, 1000);
    window.addEventListener("message", handleReturn);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("message", handleReturn);
      window.removeEventListener("focus", handleFocus);
    };
  }, [onRefresh]);

  async function startAuthorization() {
    if (creatingLink || authorizing) return;
    setConnectionError("");
    setNotice("");
    // Open synchronously so the browser does not block the window while the server signs the request.
    // Embedded browsers (IDE preview panes) refuse pop-ups; that only decides which window shows the
    // authorisation page, so a blocked pop-up falls through to this window instead of dead-ending.
    const popup = window.open("about:blank", "_blank", "popup,width=760,height=780");
    authorizationWindow.current = popup;
    setCreatingLink(true);
    try {
      const response = await fetch("/api/social/connect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not reach Postiz to start authorisation. Please try again.");
      const authorizationUrl = new URL(result.url);
      if (authorizationUrl.protocol !== "https:" || authorizationUrl.username || authorizationUrl.password) {
        throw new Error("Postiz returned an invalid authorisation link.");
      }
      if (!popup) {
        // The callback lands back on the account list, so continuing in this window still returns here.
        window.location.assign(authorizationUrl.href);
      } else if (popup.closed) {
        throw new Error("The authorisation window closed. Please try again.");
      } else {
        popup.location.href = authorizationUrl.href;
        setAuthorizing(true);
        setNotice("Complete authorisation in the new window. This workspace and your drafts stay open.");
      }
    } catch (requestError) {
      popup?.close();
      authorizationWindow.current = null;
      setConnectionError(requestError instanceof Error ? requestError.message : "Could not reach Postiz to start authorisation. Please try again.");
    } finally {
      setCreatingLink(false);
    }
  }

  if (!open) return null;
  const selectedPlatform = PLATFORM_META[provider];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogElement} className="publish-dialog connect-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-account-title" aria-describedby="connect-account-description">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">{translate("NEW CONNECTION")}</span>
            <h3 id="connect-account-title">{translate("Add social account")}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={translate("Close")}><CloseIcon size={18} /></button>
        </div>

        <div className="dialog-body connect-add-body">
          <p id="connect-account-description" className="connection-description">{translate("Choose a platform, then authorise your account on its official page. Postiz securely manages the connection.")}</p>
          <fieldset className="connection-platforms" disabled={creatingLink || authorizing}>
            <legend>{translate("Select a platform")}</legend>
            <div className="provider-grid connection-provider-grid">
              {DEFAULT_PLATFORMS.map((platform) => {
                const metadata = PLATFORM_META[platform];
                const count = accounts.filter(account => account.identifier.toLowerCase() === platform).length;
                return (
                  <label key={platform} className={`provider-tile connection-provider ${provider === platform ? "selected" : ""}`}>
                    <input type="radio" name="connection-platform" value={platform} checked={provider === platform} onChange={() => { setProvider(platform); setConnectionError(""); }} />
                    <span className="connection-provider-mark">{metadata.short}</span>
                    <strong>{metadata.label}</strong>
                    <small>{count ? `${count} ${translate("connected")}` : translate("Not connected")}</small>
                    {provider === platform && <Check size={13} className="connection-provider-check" aria-hidden="true" />}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="connection-next-step">
            <span className="connection-step-number">02</span>
            <div><strong>{translate("Authorise on")} {selectedPlatform.label}</strong><p>{translate("Use your own platform account. Polaris never asks for your social password.")}</p></div>
          </div>
          <p className="connection-security"><ShieldCheck size={15} /> {translate("Connected accounts are shared with your workspace team.")}</p>
          {!loading && !oauthConfigured && <div className="info-banner" role="status"><AlertTriangle size={18} /><div>{translate(configured
            ? "Direct authorisation requires POSTIZ_JWT_SECRET to match the Postiz server's JWT_SECRET."
            : "Postiz is not configured on the server. Set POSTIZ_API_URL and POSTIZ_API_KEY.")}</div></div>}
          {notice && <p className="connection-notice" role="status">{translate(notice)}</p>}
          {(connectionError || error) && <p className="login-error" role="alert">{translate(connectionError || error)}</p>}
        </div>

        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={() => window.open(uiUrl, "_blank", "noopener,noreferrer")} disabled={!uiUrl}>
            <ExternalLink size={14} /> {translate("Open Postiz instead")}
          </button>
          <button type="button" className="primary-button" onClick={() => void startAuthorization()} disabled={!oauthConfigured || creatingLink || authorizing}>
            {creatingLink ? <Loader2 size={15} className="spin" /> : <ArrowUpRight size={15} />}
            {translate(creatingLink ? "Preparing authorisation..." : authorizing ? "Waiting for authorisation..." : "Continue to authorisation")}
          </button>
        </div>
      </div>
    </div>
  );
}
