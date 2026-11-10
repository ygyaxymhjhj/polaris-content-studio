"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { SOCIAL_PLATFORM_META as PLATFORM_META, type SocialPlatform } from "@/lib/types";
import { formatPostTimestamp } from "@/lib/post-types";
import type { AdminPublishHistoryResponse, AdminPublishStatus } from "@/lib/admin-publish-types";

const STATUS_LABEL: Record<AdminPublishStatus, string> = {
  drafted: "Draft accepted",
  pending_review: "Pending review",
  rejected: "Review rejected",
  queued: "Queued",
  published: "Published",
  failed: "Publish failed"
};
const STATUS_CLASS: Record<AdminPublishStatus, string> = {
  drafted: "pushed", pending_review: "pushing", rejected: "attention", queued: "pushing", published: "pushed", failed: "attention"
};

type LoadResult = { page: number; revision: number } & ({ data: AdminPublishHistoryResponse } | { error: string });

export default function AdminPublishHistory() {
  const t = useTranslation();
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LoadResult>();
  const current = result?.page === page && result.revision === revision ? result : undefined;
  const data = current && "data" in current ? current.data : undefined;
  const error = current && "error" in current ? current.error : undefined;
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/admin/publishes?page=${page}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const error = response.status === 401 ? "Sign in to continue."
            : response.status === 403 ? "Only administrators can view AI publish history." : "Could not load AI publish history.";
          if (!controller.signal.aborted) setResult({ page, revision, error });
          return;
        }
        const data: AdminPublishHistoryResponse = await response.json();
        if (!controller.signal.aborted) setResult({ page, revision, data });
      } catch {
        if (!controller.signal.aborted) setResult({ page, revision, error: "Could not load AI publish history." });
      }
    }
    void load();
    return () => controller.abort();
  }, [page, revision]);

  return (
    <section className="post-editor-panel" aria-labelledby="admin-publish-history-title">
      <div className="post-editor-panel-head">
        <div>
          <h2 id="admin-publish-history-title">{t("AI publish history")}</h2>
          <p className="post-editor-panel-note">{t("Administrator-only audit summary. Private project content and links are not shown.")}</p>
        </div>
        <button type="button" className="icon-button" onClick={refresh} disabled={!current} aria-label={t("Refresh")} title={t("Refresh")}>
          <RefreshCw size={15} className={current ? "" : "spin"} aria-hidden="true" />
        </button>
      </div>
      {!current && <div className="post-editor-accounts-loading" role="status"><Loader2 size={15} className="spin" aria-hidden="true" />{t("Loading AI publish history…")}</div>}
      {error && <div className="error-banner" role="alert">{t(error)} <button type="button" className="secondary-button" onClick={refresh}>{t("Try again")}</button></div>}
      {data && !data.publishes.length && <div className="posts-empty"><ShieldCheck size={21} aria-hidden="true" /><strong>{t(page === 1 ? "No AI publish history yet." : "No records on this page.")}</strong></div>}
      {Boolean(data?.publishes.length) && <div className="posts-list">
        {data?.publishes.map((publish) => {
          const meta = PLATFORM_META[publish.platform as SocialPlatform];
          const platform = meta?.label ? t(meta.label) : publish.platform;
          return <article className="posts-row" key={publish.id}>
            <div className="posts-row-open">
              <div className="posts-row-body">
                <div className="posts-row-title-line">
                  <strong>{publish.accountName || "—"}</strong>
                  <span className={`posts-status-pill ${STATUS_CLASS[publish.status]}`}>{t(STATUS_LABEL[publish.status])}</span>
                </div>
                <div className="posts-row-meta">
                  {platform && <span>{platform}</span>}
                  <span>{t("Submitted by")} {publish.submitter || "—"}</span>
                  {publish.attemptedAt && <span>{t("Attempted at")} <time dateTime={publish.attemptedAt}>{formatPostTimestamp(publish.attemptedAt)}</time></span>}
                  {publish.scheduledAt && <span>{t("Scheduled at")} <time dateTime={publish.scheduledAt}>{formatPostTimestamp(publish.scheduledAt)}</time></span>}
                  {publish.publishedAt && <span>{t("Published at")} <time dateTime={publish.publishedAt}>{formatPostTimestamp(publish.publishedAt)}</time></span>}
                  {publish.rejectedAt && <span>{t("Review rejected at")} <time dateTime={publish.rejectedAt}>{formatPostTimestamp(publish.rejectedAt)}</time></span>}
                  {publish.lastCheckedAt && <span>{t("Last checked")} <time dateTime={publish.lastCheckedAt}>{formatPostTimestamp(publish.lastCheckedAt)}</time></span>}
                </div>
                {publish.errorCode && <div className="posts-row-meta">{t(publish.errorCode === "publishing_failed" ? "The platform reported a publishing failure." : "The AI submission could not be created.")}</div>}
              </div>
            </div>
          </article>;
        })}
      </div>}
      {(page > 1 || data?.hasNext) && <nav className="posts-pagination" aria-label={t("Pages")}>
        <button type="button" className="secondary-button" onClick={() => setPage(page - 1)} disabled={!current || page === 1}><ChevronLeft size={14} aria-hidden="true" />{t("Previous")}</button>
        <span>{t("Page")} {page}</span>
        <button type="button" className="secondary-button" onClick={() => setPage(page + 1)} disabled={!data?.hasNext}>{t("Next")}<ChevronRight size={14} aria-hidden="true" /></button>
      </nav>}
    </section>
  );
}
