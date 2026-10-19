"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Gauge,
  Loader2,
  Plus,
  RefreshCw,
  Send
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";
import {
  formatPostTimestamp,
  type ManualPostStatus,
  type OverviewResponse
} from "@/lib/post-types";

export default function OverviewView({
  accounts,
  accountsLoading,
  accountsError,
  onRefreshAccounts,
  onOpenAccounts,
  onOpenPosts,
  onNewPost,
  onOpenWorkspace,
  refreshToken
}: {
  accounts: SocialAccount[];
  accountsLoading: boolean;
  accountsError: string;
  onRefreshAccounts: () => void;
  onOpenAccounts: () => void;
  onOpenPosts: (filter: "all" | ManualPostStatus) => void;
  onNewPost: () => void;
  onOpenWorkspace: () => void;
  refreshToken: number;
}) {
  const t = useTranslation();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [within, setWithin] = useState<"24h" | "7d">("24h");
  const requestSequence = useRef(0);

  const loadOverview = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/overview?within=${within}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as OverviewResponse & { error?: string };
      if (sequence !== requestSequence.current) return;
      if (!response.ok) throw new Error(data.error || "The overview could not be loaded.");
      setOverview(data);
      setError("");
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "The overview could not be loaded.");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [within]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshToken]);

  const counts = overview?.counts ?? { total: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 };
  const readyAccounts = accounts.filter((account) => !account.disabled);
  const needsReconnect = accounts.length - readyAccounts.length;

  const metrics: { id: string; label: string; value: string; hint: string; tone?: string; onClick: () => void }[] = [
    {
      id: "accounts",
      label: t("Connected accounts"),
      value: accountsLoading && !accounts.length ? "—" : String(accounts.length),
      hint: needsReconnect ? `${needsReconnect} ${t("need reconnecting")}` : t("Ready for drafts"),
      tone: accountsError ? "warn" : undefined,
      onClick: onOpenAccounts
    },
    {
      id: "draft",
      label: t("Local drafts"),
      value: String(counts.draft),
      hint: t("Not handed to Postiz yet"),
      onClick: () => onOpenPosts("draft")
    },
    {
      id: "pushed",
      label: t("Drafts pushed"),
      value: String(counts.pushed),
      hint: t("Every selected account accepted"),
      onClick: () => onOpenPosts("pushed")
    },
    {
      id: "attention",
      label: t("Needs attention"),
      value: String(counts.attention + counts.pushing),
      hint: counts.pushing ? `${counts.pushing} ${t("submitting now")}` : t("Rejections, failures, unknown results or partial delivery"),
      tone: counts.attention ? "warn" : undefined,
      onClick: () => onOpenPosts("attention")
    }
  ];

  return (
    <section className="overview-view" aria-labelledby="overview-title">
      <header className="overview-heading">
        <div>
          <div className="eyebrow">{t("MANUAL POSTS OVERVIEW")}</div>
          <h1 id="overview-title">{t("Overview")}</h1>
          <p>{t("Hand-written posts, their Postiz draft hand-off and the accounts they use. AI-generated assets stay in the workspace.")}</p>
        </div>
        <div className="overview-heading-actions">
          <button type="button" className="secondary-button" onClick={onOpenWorkspace}>
            <Gauge size={15} aria-hidden="true" /> {t("Open the AI workspace")}
          </button>
          <button type="button" className="primary-button" onClick={onNewPost}>
            <Plus size={16} aria-hidden="true" /> {t("New post")}
          </button>
        </div>
      </header>

      {error && (
        <div className="info-banner" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{t(error)} <button type="button" className="text-button" onClick={() => void loadOverview()}>{t("Retry")}</button></div>
        </div>
      )}

      <div className="overview-metrics">
        {metrics.map((metric) => (
          <button
            key={metric.id}
            type="button"
            className={`overview-metric ${metric.tone || ""}`}
            onClick={metric.onClick}
          >
            <span className="overview-metric-label">{metric.label}</span>
            <span className="overview-metric-value">{metric.value}</span>
            <span className="overview-metric-hint">{metric.hint}</span>
            <ArrowRight className="overview-metric-arrow" size={15} aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="overview-columns">
        <section className="overview-panel" aria-labelledby="overview-activity-title">
          <div className="overview-panel-head">
            <h2 id="overview-activity-title">{t("Recent activity")}</h2>
            <div className="overview-window-tabs" role="tablist" aria-label={t("Activity window")}>
              {(["24h", "7d"] as const).map((window) => (
                <button
                  key={window}
                  type="button"
                  role="tab"
                  aria-selected={within === window}
                  className={`overview-window-tab ${within === window ? "active" : ""}`}
                  onClick={() => setWithin(window)}
                >
                  {window === "24h" ? t("Last 24 hours") : t("Last 7 days")}
                </button>
              ))}
            </div>
          </div>
          {loading && !overview ? (
            <div className="overview-activity-loading" aria-busy="true"><Loader2 className="spin" size={16} aria-hidden="true" /> {t("Loading activity…")}</div>
          ) : overview?.activity.length ? (
            <ul className="overview-activity">
              {overview.activity.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="overview-activity-row" onClick={() => onOpenPosts("all")}>
                    <span className={`overview-activity-dot ${entry.kind}`} aria-hidden="true" />
                    <span className="overview-activity-copy">
                      <strong>{t(activityLabel(entry.kind))}</strong>
                      <span>
                        {entry.title || t("Untitled post")}
                        {entry.accountName ? ` · ${entry.accountName}` : ""}
                      </span>
                    </span>
                    <span className="overview-activity-time">{formatPostTimestamp(entry.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="overview-empty">
              <FileText size={20} aria-hidden="true" />
              <p>{t("No manual post activity in this window.")}</p>
              <button type="button" className="text-button" onClick={onNewPost}>{t("Write the first post")}</button>
            </div>
          )}
        </section>

        <section className="overview-panel" aria-labelledby="overview-accounts-title">
          <div className="overview-panel-head">
            <h2 id="overview-accounts-title">{t("Account status")}</h2>
            <button type="button" className="text-button" onClick={onRefreshAccounts} disabled={accountsLoading}>
              <RefreshCw size={12} className={accountsLoading ? "spin" : undefined} aria-hidden="true" /> {t("Refresh")}
            </button>
          </div>
          {accountsError ? (
            <div className="overview-empty warn">
              <AlertTriangle size={20} aria-hidden="true" />
              <p>{t("The account list is unavailable, so no account count is shown.")}</p>
              <button type="button" className="text-button" onClick={onRefreshAccounts}>{t("Retry")}</button>
            </div>
          ) : accountsLoading && !accounts.length ? (
            <div className="overview-activity-loading" aria-busy="true"><Loader2 className="spin" size={16} aria-hidden="true" /> {t("Loading accounts…")}</div>
          ) : accounts.length ? (
            <>
              <ul className="overview-accounts">
                {accounts.slice(0, 6).map((account) => {
                  const meta = PLATFORM_META[account.identifier as Platform];
                  return (
                    <li key={account.id} className="overview-account-row">
                      <span className="posts-platform-mark" style={{ "--chip-accent": meta?.accent || "#71717a" } as React.CSSProperties}>
                        {meta?.short || account.identifier.slice(0, 2).toUpperCase() || "?"}
                      </span>
                      <span className="overview-account-copy">
                        <strong>{account.name}</strong>
                        <small>{meta?.label || account.identifier || t("Other")}</small>
                      </span>
                      <span className={`overview-account-state ${account.disabled ? "warn" : "ok"}`}>
                        {account.disabled ? <><AlertTriangle size={12} aria-hidden="true" /> {t("Needs reconnect")}</> : <><CheckCircle2 size={12} aria-hidden="true" /> {t("Ready")}</>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {accounts.length > 6 && <button type="button" className="text-button overview-accounts-more" onClick={onOpenAccounts}>{t("View all accounts")} <ArrowRight size={12} aria-hidden="true" /></button>}
            </>
          ) : (
            <div className="overview-empty">
              <Send size={20} aria-hidden="true" />
              <p>{t("No accounts are available yet. Connect a platform, or ask an administrator to assign one.")}</p>
              <button type="button" className="secondary-button" onClick={onOpenAccounts}>{t("Open accounts")}</button>
            </div>
          )}
        </section>
      </div>

      <div className="overview-footnote">
        {t("These numbers cover manual posts only. AI-generated assets are tracked in the workspace and export centre.")}
      </div>
    </section>
  );
}

function activityLabel(kind: OverviewResponse["activity"][number]["kind"] | "rejected"): string {
  switch (kind) {
    case "created": return "Post created";
    case "updated": return "Post updated";
    case "submitted": return "Draft submission started";
    case "accepted": return "Draft accepted by Postiz";
    case "rejected": return "Review rejected";
    case "failed": return "Draft refused";
    case "pending": return "Submission needs review";
    default: return "Activity";
  }
}
