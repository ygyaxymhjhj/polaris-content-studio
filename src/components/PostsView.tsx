"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ImageOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Video
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { SOCIAL_PLATFORM_META as PLATFORM_META, type SocialPlatform as Platform, type SocialAccount } from "@/lib/types";
import {
  POST_STATUS_LABEL,
  formatPostTimestamp,
  type ManualPostListItem,
  type ManualPostStatus,
  type PostsCounts,
  type PostsListResponse
} from "@/lib/post-types";

const PER_PAGE = 20;

const statusTabs: { id: "all" | ManualPostStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Local drafts" },
  { id: "pushing", label: "Submitting" },
  { id: "pushed", label: "Pushed" },
  { id: "attention", label: "Needs attention" }
];

const withinOptions = [
  { id: "all", label: "Any time" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" }
];

function PlatformMarks({ platforms }: { platforms: string[] }) {
  if (!platforms.length) return null;
  return (
    <span className="posts-platform-marks">
      {platforms.map((platform) => {
        const meta = PLATFORM_META[platform as Platform];
        return (
          <span
            key={platform}
            className="posts-platform-mark"
            style={{ "--chip-accent": meta?.accent || "#71717a" } as React.CSSProperties}
            title={meta?.label || platform}
          >
            {meta?.short || platform.slice(0, 2).toUpperCase()}
          </span>
        );
      })}
    </span>
  );
}

export default function PostsView({
  accounts,
  accountsLoading,
  accountsError,
  onOpenPost,
  onNewPost,
  onOpenAccounts,
  initialStatus,
  refreshToken
}: {
  accounts: SocialAccount[];
  accountsLoading: boolean;
  accountsError: string;
  onOpenPost: (postId: string) => void;
  onNewPost: () => void;
  onOpenAccounts: () => void;
  /** Set when the overview cards open the list on a specific tab. */
  initialStatus: "all" | ManualPostStatus;
  refreshToken: number;
}) {
  const t = useTranslation();
  const [posts, setPosts] = useState<ManualPostListItem[]>([]);
  const [counts, setCounts] = useState<PostsCounts>({ all: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 });
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"all" | ManualPostStatus>(initialStatus);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [account, setAccount] = useState("");
  const [within, setWithin] = useState("all");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyPostId, setBusyPostId] = useState("");
  const requestSequence = useRef(0);
  const activeRequest = useRef<number | null>(null);
  const actionPending = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadPosts = useCallback(async (quiet = false) => {
    if (quiet && (document.hidden || activeRequest.current !== null || actionPending.current)) return;
    const sequence = ++requestSequence.current;
    activeRequest.current = sequence;
    if (!quiet) setLoading(true);
    try {
      const parameters = new URLSearchParams({ status, page: String(page), perPage: String(PER_PAGE) });
      if (debouncedSearch) parameters.set("search", debouncedSearch);
      if (platform) parameters.set("platform", platform);
      if (account) parameters.set("account", account);
      if (within !== "all") parameters.set("updatedWithin", within);
      const response = await fetch(`/api/posts?${parameters}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as Partial<PostsListResponse> & { error?: string };
      if (sequence !== requestSequence.current) return;
      if (!response.ok) throw new Error(data.error || "The posts list could not be loaded.");
      setPosts(Array.isArray(data.posts) ? data.posts : []);
      setCounts(data.counts || { all: 0, draft: 0, pushing: 0, pushed: 0, attention: 0 });
      setTotal(Number(data.total) || 0);
      setError("");
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "The posts list could not be loaded.");
    } finally {
      if (activeRequest.current === sequence) activeRequest.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [status, page, debouncedSearch, platform, account, within]);

  useEffect(() => {
    void loadPosts();
    const refresh = () => { void loadPosts(true); };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      requestSequence.current += 1;
      activeRequest.current = null;
    };
  }, [loadPosts, refreshToken]);

  // Filters are a fresh query, not a deeper page of the previous one.
  useEffect(() => {
    setPage(1);
  }, [status, debouncedSearch, platform, account, within]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const filtersActive = Boolean(debouncedSearch || platform || account || within !== "all");
  const hasAnyPost = counts.all > 0 || filtersActive;

  function clearFilters() {
    setSearch("");
    setPlatform("");
    setAccount("");
    setWithin("all");
    setStatus("all");
  }

  async function duplicatePost(post: ManualPostListItem) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusyPostId(post.id);
    setActionError("");
    try {
      const response = await fetch(`/api/posts/${post.id}/duplicate`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { post?: { id: string }; error?: string };
      if (!response.ok || !data.post) throw new Error(data.error || "The post could not be copied.");
      onOpenPost(data.post.id);
    } catch (duplicateError) {
      setActionError(duplicateError instanceof Error ? duplicateError.message : "The post could not be copied.");
    } finally {
      actionPending.current = false;
      setBusyPostId("");
    }
  }

  async function deletePost(post: ManualPostListItem) {
    if (actionPending.current) return;
    if (!window.confirm(t("Delete this local draft permanently? Nothing has been sent to Postiz for it."))) return;
    actionPending.current = true;
    setBusyPostId(post.id);
    setActionError("");
    try {
      const response = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || "The post could not be deleted.");
      void loadPosts();
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : t("The post could not be deleted."));
    } finally {
      actionPending.current = false;
      setBusyPostId("");
    }
  }

  const accountOptions = useMemo(
    () => [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts]
  );

  return (
    <section className="posts-view" aria-labelledby="posts-title">
      <header className="posts-heading">
        <div>
          <div className="eyebrow">{t("MANUAL POSTS")}</div>
          <h1 id="posts-title">{t("Posts")}</h1>
          <p>{t("Write and manage your social drafts.")}</p>
        </div>
        <div className="posts-heading-actions">
          <button type="button" className="secondary-button" onClick={() => void loadPosts()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} /> {t("Refresh")}
          </button>
          <button type="button" className="primary-button" onClick={onNewPost}>
            <Plus size={16} /> {t("New post")}
          </button>
        </div>
      </header>

      <div className="posts-toolbar">
        <div className="posts-status-tabs" role="tablist" aria-label={t("Post status")}>
          {statusTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={status === tab.id}
              className={`posts-status-tab ${status === tab.id ? "active" : ""}`}
              onClick={() => setStatus(tab.id)}
            >
              {t(tab.label)} <span>{tab.id === "all" ? counts.all : counts[tab.id]}</span>
            </button>
          ))}
        </div>

        <div className="posts-filters">
          <label className="posts-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search title or text")}
              aria-label={t("Search title or text")}
            />
          </label>
          <label className="posts-select">
            <span className="sr-only">{t("Platform")}</span>
            <select value={platform} onChange={(event) => setPlatform(event.target.value)} aria-label={t("Platform")}>
              <option value="">{t("All platforms")}</option>
              {Object.entries(PLATFORM_META).map(([key, meta]) => (
                <option key={key} value={key}>{t(meta.label)}</option>
              ))}
            </select>
          </label>
          <label className="posts-select">
            <span className="sr-only">{t("Account")}</span>
            <select value={account} onChange={(event) => setAccount(event.target.value)} aria-label={t("Account")} disabled={accountsLoading && !accounts.length}>
              <option value="">{t("All accounts")}</option>
              {accountOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
          <label className="posts-select">
            <span className="sr-only">{t("Updated")}</span>
            <select value={within} onChange={(event) => setWithin(event.target.value)} aria-label={t("Updated")}>
              {withinOptions.map((option) => (
                <option key={option.id} value={option.id}>{t(option.label)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {accountsError && (
        <div className="info-banner" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{t("The account list is unavailable, so account filters and submission are paused.")} <button type="button" className="text-button" onClick={onOpenAccounts}>{t("Open accounts")}</button></div>
        </div>
      )}
      {actionError && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(actionError)}</div></div>}
      {error && (
        <div className="info-banner" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{t(error)} <button type="button" className="text-button" onClick={() => void loadPosts()}>{t("Retry")}</button></div>
        </div>
      )}

      {loading && !posts.length ? (
        <div className="posts-list" aria-busy="true">
          {[0, 1, 2].map((row) => <div className="posts-row skeleton" key={row}><div className="posts-row-thumb" /><div className="posts-row-body"><div className="skeleton-line" /><div className="skeleton-line short" /></div></div>)}
        </div>
      ) : posts.length ? (
        <div className="posts-list">
          {posts.map((post) => (
            <article className="posts-row" key={post.id}>
              <button type="button" className="posts-row-open" onClick={() => onOpenPost(post.id)} aria-label={`${t("Open post")}: ${post.title || post.excerpt.slice(0, 60)}`}>
                <span className="posts-row-thumb">
                  {post.hasVideo ? <Video size={24} aria-label={t("Post video")} /> : post.hasImage ? (
                    <img src={post.imageUrl || `/api/posts/${post.id}/image?size=thumb&v=${post.imageVersion}`} alt="" loading="lazy" />
                  ) : (
                    <ImageOff size={17} aria-hidden="true" />
                  )}
                  {(post.imageCount ?? 0) > 1 && <span className="posts-platform-mark" aria-label={`${post.imageCount} ${t("images")}`}>{post.imageCount}</span>}
                </span>
                <span className="posts-row-body">
                  <span className="posts-row-title-line">
                    <strong>{post.title || t("Untitled post")}</strong>
                    <span className={`posts-status-pill ${post.status}${(post.rejectedCount ?? 0) > 0 ? " rejected" : ""}`}>
                      {t((post.rejectedCount ?? 0) > 0 ? "Review rejected" : POST_STATUS_LABEL[post.status])}
                    </span>
                  </span>
                  <span className="posts-row-excerpt">{post.excerpt || t("No text yet")}</span>
                  <span className="posts-row-meta">
                    <PlatformMarks platforms={post.platforms} />
                    <span className="posts-row-progress">
                      <Send size={12} aria-hidden="true" />
                      {post.targetCount ? `${t("Pushed")} ${post.acceptedCount} / ${post.targetCount} ${t("accounts")}` : t("No accounts selected")}
                    </span>
                    <span className="posts-row-time">{t("Updated")} {formatPostTimestamp(post.updatedAt)}</span>
                  </span>
                </span>
              </button>
              <div className="posts-row-actions">
                <button type="button" className="icon-button" title={t("Copy as a new draft")} aria-label={t("Copy as a new draft")} disabled={busyPostId === post.id} onClick={() => void duplicatePost(post)}>
                  {busyPostId === post.id ? <Loader2 className="spin" size={15} /> : <Copy size={15} />}
                </button>
                {post.deletable && (
                  <button type="button" className="secondary-button danger" disabled={Boolean(busyPostId)} onClick={() => void deletePost(post)}>
                    <Trash2 size={15} aria-hidden="true" /> {t("Delete local draft")}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="posts-empty">
          {error ? (
            <>
              <span className="posts-empty-icon"><AlertTriangle size={24} aria-hidden="true" /></span>
              <h3>{t("The posts list could not be loaded")}</h3>
              <p>{t("Nothing was lost. Retry, or check the database connection.")}</p>
              <button type="button" className="secondary-button" onClick={() => void loadPosts()}>{t("Retry")}</button>
            </>
          ) : hasAnyPost ? (
            <>
              <span className="posts-empty-icon"><Search size={24} aria-hidden="true" /></span>
              <h3>{t("No posts match these filters")}</h3>
              <p>{t("Clear the filters to see every post, or write a new one.")}</p>
              <button type="button" className="secondary-button" onClick={clearFilters}>{t("Clear filters")}</button>
            </>
          ) : (
            <>
              <span className="posts-empty-icon"><Send size={24} aria-hidden="true" /></span>
              <h3>{t("Create your first post")}</h3>
              <p>{t("Write the text and add an image or MP4, then submit a draft for review.")}</p>
              <div className="posts-empty-actions">
                <button type="button" className="primary-button" onClick={onNewPost}><Plus size={15} /> {t("New post")}</button>
                {!accounts.length && !accountsLoading && <button type="button" className="secondary-button" onClick={onOpenAccounts}>{t("Connect an account")}</button>}
              </div>
            </>
          )}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="posts-pagination" aria-label={t("Pages")}>
          <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            <ChevronLeft size={15} /> {t("Previous")}
          </button>
          <span>{t("Page")} {page} / {totalPages}</span>
          <button type="button" className="secondary-button" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
            {t("Next")} <ChevronRight size={15} />
          </button>
        </nav>
      )}
    </section>
  );
}
