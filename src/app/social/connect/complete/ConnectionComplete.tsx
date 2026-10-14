"use client";

import { useEffect, useState } from "react";
import { translate, type UiLanguage } from "@/lib/i18n";
import { AUTHORIZATION_POPUP_STORAGE_KEY, CONNECTION_MESSAGES, type ConnectionOutcome } from "@/lib/social-connect-result";
import styles from "./complete.module.css";

type Props = {
  outcome: ConnectionOutcome;
  returnPath: string;
  retryPath: string | null;
};

export default function ConnectionComplete({ outcome, returnPath, retryPath }: Props) {
  const [language, setLanguage] = useState<UiLanguage>("en");
  const [closeRequested, setCloseRequested] = useState(false);
  const succeeded = outcome === "returned";
  const localize = (text: string) => translate(language, text);

  useEffect(() => {
    try {
      const savedLanguage = localStorage.getItem("polaris-ui-language");
      if (savedLanguage === "zh" || savedLanguage === "en" || savedLanguage === "vi" || savedLanguage === "th") {
        setLanguage(savedLanguage);
      } else if (navigator.language.startsWith("zh")) {
        setLanguage("zh");
      }
    } catch {
      if (navigator.language.startsWith("zh")) setLanguage("zh");
    }

    let isAuthorizationPopup = Boolean(window.opener);
    try {
      isAuthorizationPopup ||= sessionStorage.getItem(AUTHORIZATION_POPUP_STORAGE_KEY) === "1";
      if (outcome === "returned") sessionStorage.removeItem(AUTHORIZATION_POPUP_STORAGE_KEY);
    } catch { /* An available opener also identifies the authorization popup. */ }
    try {
      window.opener?.postMessage({ type: "POLARIS_POSTIZ_RETURNED", outcome }, window.location.origin);
    } catch {
      // The visible return links also work when the opener is no longer reachable.
    }
    if (outcome === "returned" && isAuthorizationPopup) window.close();
  }, [outcome]);

  return (
    <main className="login-shell" lang={language}>
      <section className={`login-panel ${styles.panel}`} aria-labelledby="connection-result-title">
        <div className="brand-lockup login-brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div><div className="brand-name">POLARIS</div><div className="brand-product">Content Studio</div></div>
        </div>
        <h1 id="connection-result-title">{localize(succeeded ? "Authorisation completed" : "Authorisation needs attention")}</h1>
        <p className={succeeded ? "login-intro" : `login-error ${styles.message}`} role={succeeded ? "status" : "alert"}>
          {localize(CONNECTION_MESSAGES[outcome])}
        </p>
        {succeeded && <p className="login-intro">{localize("You can return to the workspace. If this window stays open, close it manually.")}</p>}
        <div className={styles.actions}>
          {retryPath && <a className="primary-button" href={retryPath} referrerPolicy="no-referrer">{localize("Retry return check")}</a>}
          <a className={retryPath ? "secondary-button" : "primary-button"} href={outcome === "unauthenticated" ? "/login" : returnPath} referrerPolicy="no-referrer">
            {localize(outcome === "unauthenticated" ? "Return to sign in" : "Return to workspace")}
          </a>
          <button type="button" className="secondary-button" onClick={() => { setCloseRequested(true); window.close(); }}>
            {localize("Close window")}
          </button>
        </div>
        {closeRequested && <p className={styles.closeHint} role="status">{localize("If this tab cannot close automatically, use the return link or close it manually.")}</p>}
      </section>
    </main>
  );
}
