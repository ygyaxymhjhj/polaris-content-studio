"use client";

import { useEffect, useState } from "react";
import { LocaleContext, translate, type UiLanguage } from "@/lib/i18n";

export default function LoginForm() {
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("en");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Same key ContentStudio persists to, so the chosen language survives the sign-in navigation.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("polaris-ui-language");
      if (saved === "zh" || saved === "vi" || saved === "th") setUiLanguage(saved);
    } catch { /* Optional preference. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = uiLanguage === "zh" ? "zh-CN" : uiLanguage === "th" ? "th-TH" : uiLanguage; }, [uiLanguage]);

  const t = (text: string) => translate(uiLanguage, text);

  function changeUiLanguage(value: UiLanguage) {
    setUiLanguage(value);
    try { localStorage.setItem("polaris-ui-language", value); } catch { /* Optional preference. */ }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(t(data.error || "Sign-in failed. Try again."));
        setBusy(false);
        return;
      }
      // Full navigation, not router.push: the guard lives in a server component that must see the new cookie.
      location.assign(data.claimed > 0 ? `/?claimed=${data.claimed}` : "/");
    } catch {
      setError(t("Cannot reach the server. Check the connection and try again."));
      setBusy(false);
    }
  }

  return (
    <LocaleContext.Provider value={uiLanguage}>
      <div className="login-shell">
        <form className="login-panel" onSubmit={submit}>
          <div className="brand-lockup login-brand">
            <div className="brand-mark"><span>✦</span></div>
            <div>
              <div className="brand-name">POLARIS</div>
              <div className="brand-product">Content Studio</div>
            </div>
          </div>
          <h1>{t("Sign in")}</h1>
          <p className="login-intro">{t("Internal workspace. Ask an administrator for an account.")}</p>
          <label className="field-label">
            {t("Username")}
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required />
          </label>
          <label className="field-label">
            {t("Password")}
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="primary-button full large" disabled={busy}>{busy ? t("Signing in…") : t("Sign in")}</button>
          <label className="locale-switcher login-language">
            <span>{t("Interface language")}</span>
            <select aria-label={t("Interface language")} value={uiLanguage} onChange={(event) => changeUiLanguage(event.target.value as UiLanguage)}>
              <option value="en">{t("English")}</option>
              <option value="zh">简体中文</option>
              <option value="vi">Tiếng Việt</option>
              <option value="th">ไทย</option>
            </select>
          </label>
        </form>
      </div>
    </LocaleContext.Provider>
  );
}
