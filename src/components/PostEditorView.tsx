"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  ImageOff,
  Loader2,
  Save,
  Send,
  ShieldCheck
} from "lucide-react";
import { LocaleContext, translate } from "@/lib/i18n";
import AssetImageEditor from "@/components/AssetImageEditor";
import SocialPreview from "@/components/SocialPreview";
import { PLATFORM_META, type ContentAsset, type Platform, type SocialAccount } from "@/lib/types";
import {
  MAX_POST_TARGETS,
  POST_CONTENT_MAX_LENGTH,
  POST_TARGET_STATUS_LABEL,
  POST_TITLE_MAX_LENGTH,
  formatPostTimestamp,
  isSupportedPlatform,
  platformRuleFor,
  type ManualPostDetail,
  type PostTarget
} from "@/lib/post-types";

/**
 * Manual post editor. The same view serves composing, editing and the read-only snapshot: once any
 * account has accepted the draft the server refuses further content changes, so the fields render
 * disabled with an explanation instead of silently dropping edits.
 *
 * Saving is debounced and version-checked: the first effective edit creates the row, later edits
 * PATCH it with the version the browser last saw, so a second tab cannot be overwritten silently.
 */

type Account = SocialAccount;

export default function PostEditorView({
  postId,
  accounts,
  accountsLoading,
  accountsError,
  postizUiUrl,
  isAdmin,
  onBack,
  onOpened,
  onSaved,
  onOpenAccounts,
  onRefreshAccounts
}: {
  /** "new" starts an empty composer; the URL is upgraded to the saved id by onOpened. */
  postId: string | "new";
  accounts: Account[];
  accountsLoading: boolean;
  accountsError: string;
  postizUiUrl: string;
  isAdmin: boolean;
  onBack: () => void;
  onOpened: (postId: string) => void;
  onSaved: () => void;
  onOpenAccounts: () => void;
  onRefreshAccounts: () => void;
}) {
  // A stable translator: every callback below lists it as a dependency, and useTranslation returns
  // a fresh function each render, which would re-create the autosave and push callbacks constantly.
  const uiLanguage = useContext(LocaleContext);
  const t = useCallback((text: string) => translate(uiLanguage, text), [uiLanguage]);
  const [post, setPost] = useState<ManualPostDetail | null>(null);
  const [loading, setLoading] = useState(postId !== "new");
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [image, setImage] = useState("");
  const [imageDirty, setImageDirty] = useState(false);
  const [imageName, setImageName] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [frozenNotice, setFrozenNotice] = useState("");
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState("");
  const [previewPlatform, setPreviewPlatform] = useState<Platform>("x");
  const [savedRevision, setSavedRevision] = useState(0);
  const [copiedNotice, setCopiedNotice] = useState("");

  const postRef = useRef<ManualPostDetail | null>(null);
  const versionRef = useRef(0);
  const savedPayload = useRef("");
  const saveFlight = useRef<Promise<ManualPostDetail | null> | null>(null);
  const payloadRef = useRef({ title, content, image, imageDirty, imageName, targetIds });
  payloadRef.current = { title, content, image, imageDirty, imageName, targetIds };

  const applyDetail = useCallback((detail: ManualPostDetail, options: { resetFields: boolean }) => {
    setPost(detail);
    postRef.current = detail;
    versionRef.current = detail.version;
    if (options.resetFields) {
      setTitle(detail.title);
      setContent(detail.content);
      setImage(detail.imageUrl ?? "");
      setImageDirty(false);
      setImageName(detail.imageName ?? "");
      setTargetIds(detail.targets.map((target) => target.integrationId));
      const firstPlatform = detail.targets[0]?.platform || "";
      setPreviewPlatform(isSupportedPlatform(firstPlatform) ? firstPlatform : "x");
    }
    savedPayload.current = JSON.stringify([detail.title, detail.content, false, detail.targets.map((target) => target.integrationId).sort().join(",")]);
    setSavedRevision((revision) => revision + 1);
  }, []);

  // Load the post (or reset for a new one). A reload of the id we already hold only refreshes the
  // server state, so edits typed while the URL was being upgraded from "new" are not clobbered.
  useEffect(() => {
    if (postId === "new") {
      setPost(null); postRef.current = null; versionRef.current = 0;
      setTitle(""); setContent(""); setImage(""); setImageDirty(false); setImageName("");
      setTargetIds([]); setPreviewPlatform("x");
      savedPayload.current = JSON.stringify(["", "", false, ""]);
      setSavedRevision((revision) => revision + 1);
      setLoading(false); setLoadError(""); setConflict(false); setSaveError(""); setSubmitError(""); setFrozenNotice("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    (async () => {
      try {
        const response = await fetch(`/api/posts/${postId}`, { cache: "no-store" });
        const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
        if (cancelled) return;
        if (!response.ok || !data.post) throw new Error(data.error || "The post could not be loaded.");
        if (postRef.current?.id === data.post.id) {
          setPost(data.post); postRef.current = data.post; versionRef.current = data.post.version;
          setSavedRevision((revision) => revision + 1);
        } else {
          applyDetail(data.post, { resetFields: true });
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "The post could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [postId, applyDetail]);

  const payloadKey = useMemo(
    () => JSON.stringify([title, content, imageDirty, [...targetIds].sort().join(",")]),
    [title, content, imageDirty, targetIds]
  );
  // Save results live in a ref, so the re-render that setSavedRevision triggers is what makes this
  // comparison visible to the next render; savedRevision itself is not read here on purpose.
  const dirty = payloadKey !== savedPayload.current;
  void savedRevision;
  const editable = post ? post.editable : true;

  const reloadPost = useCallback(async () => {
    const current = postRef.current;
    if (!current) return;
    try {
      const response = await fetch(`/api/posts/${current.id}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
      if (!response.ok || !data.post) throw new Error(data.error || "The post could not be reloaded.");
      applyDetail(data.post, { resetFields: true });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The post could not be reloaded.");
    } finally {
      // The local edits are gone either way; a stale conflict banner would only confuse.
      setConflict(false);
    }
  }, [applyDetail]);

  const createPost = useCallback(async (): Promise<ManualPostDetail | null> => {
    const payload = payloadRef.current;
    const body: Record<string, unknown> = {
      title: payload.title.trim(),
      content: payload.content,
      integrationIds: payload.targetIds
    };
    if (payload.imageDirty && payload.image.startsWith("data:")) {
      body.imageDataUrl = payload.image;
      if (payload.imageName) body.imageName = payload.imageName;
    }
    const sentTitle = String(body.title);
    const sentContent = String(body.content);
    const sentImageIncluded = Boolean(body.imageDataUrl);
    const response = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
    if (!response.ok || !data.post) throw new Error(data.error || "The post could not be saved.");
    const detail = data.post;
    setPost(detail); postRef.current = detail; versionRef.current = detail.version;
    savedPayload.current = JSON.stringify([sentTitle, sentContent, false, detail.targets.map((target) => target.integrationId).sort().join(",")]);
    if (sentImageIncluded && payloadRef.current.image === payload.image) {
      setImage(detail.imageUrl ?? "");
      setImageDirty(false);
    }
    setSavedRevision((revision) => revision + 1);
    onOpened(detail.id);
    onSaved();
    return detail;
  }, [onOpened, onSaved]);

  const patchPost = useCallback(async (current: ManualPostDetail): Promise<ManualPostDetail | null> => {
    const payload = payloadRef.current;
    const body: Record<string, unknown> = {
      version: versionRef.current,
      title: payload.title.trim(),
      content: payload.content,
      integrationIds: payload.targetIds
    };
    if (payload.imageDirty) {
      body.imageDataUrl = payload.image ? payload.image : null;
      if (payload.image && !payload.image.startsWith("/api/") && payload.imageName) body.imageName = payload.imageName;
    }
    const response = await fetch(`/api/posts/${current.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string; code?: string };
    if (response.status === 409) {
      if (data.code === "POST_FROZEN") {
        setFrozenNotice(data.error || "This post is now read-only because a draft was handed to Postiz.");
        await reloadPost();
        return null;
      }
      setConflict(true);
      return null;
    }
    if (!response.ok || !data.post) throw new Error(data.error || "The post could not be saved.");
    const detail = data.post;
    setPost(detail); postRef.current = detail; versionRef.current = detail.version;
    savedPayload.current = JSON.stringify([String(body.title), String(body.content), false, detail.targets.map((target) => target.integrationId).sort().join(",")]);
    if (payload.imageDirty && payloadRef.current.image === payload.image) {
      setImage(detail.imageUrl ?? "");
      setImageDirty(false);
    }
    setSavedRevision((revision) => revision + 1);
    onSaved();
    return detail;
  }, [onSaved, reloadPost]);

  // Every value this reads comes from refs that are refreshed on each render, so the identity only
  // changes when the parent hands over new callbacks.
  const save = useCallback(async (): Promise<ManualPostDetail | null> => {
    if (saveFlight.current) return saveFlight.current;
    const flight = (async (): Promise<ManualPostDetail | null> => {
      const payload = payloadRef.current;
      const key = JSON.stringify([payload.title, payload.content, payload.imageDirty, [...payload.targetIds].sort().join(",")]);
      const current = postRef.current;
      if (key === savedPayload.current) return current;
      setSaveError("");
      setSaving(true);
      try {
        if (!current) {
          // An untouched page must never create a record.
          if (!payload.title.trim() && !payload.content.trim() && !payload.image) return null;
          return await createPost();
        }
        return await patchPost(current);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "The post could not be saved.");
        return null;
      } finally {
        setSaving(false);
      }
    })().finally(() => { saveFlight.current = null; });
    saveFlight.current = flight;
    return flight;
  }, [createPost, patchPost]);

  // Debounced autosave. It stays parked while accounts are submitting: those requests carry the
  // current version, and a save landing in between would invalidate them mid-flight.
  useEffect(() => {
    if (!dirty || loading || conflict || imageBusy || submitting.length) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, loading, conflict, imageBusy, submitting.length, save, title, content, image, imageDirty, targetIds, postId]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (dirty || saving || submitting.length) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, saving, submitting.length]);

  const pushTargets = useCallback(async (integrationIds: string[]) => {
    if (!integrationIds.length) return;
    setSubmitError("");
    setFrozenNotice("");
    const saved = await save();
    if (!saved) {
      setSubmitError(t("Save the post before submitting it."));
      return;
    }
    setSubmitting((current) => [...new Set([...current, ...integrationIds])]);
    const queue = [...integrationIds];
    // Two at a time: enough to feel parallel without a burst that a small Postiz instance cannot take.
    const worker = async () => {
      while (queue.length) {
        const integrationId = queue.shift();
        if (!integrationId) return;
        try {
          const response = await fetch(`/api/posts/${saved.id}/targets/${encodeURIComponent(integrationId)}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedVersion: versionRef.current })
          });
          const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string; code?: string };
          if (response.ok && data.post) {
            setPost(data.post); postRef.current = data.post; versionRef.current = data.post.version;
            setSavedRevision((revision) => revision + 1);
          } else {
            setSubmitError(data.error || "The submission failed.");
            if (data.code === "CONFLICT" || data.code === "UNCONFIRMED" || data.code === "IN_FLIGHT") await reloadPost();
          }
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : "The submission failed.");
        } finally {
          setSubmitting((current) => current.filter((id) => id !== integrationId));
        }
      }
    };
    await Promise.all([worker(), worker()]);
    onSaved();
  }, [save, onSaved, reloadPost, t]);

  async function copyAsNewDraft() {
    const current = postRef.current;
    if (!current) return;
    setCopiedNotice("");
    try {
      const response = await fetch(`/api/posts/${current.id}/duplicate`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
      if (!response.ok || !data.post) throw new Error(data.error || "The post could not be copied.");
      onOpened(data.post.id);
    } catch (error) {
      setCopiedNotice(error instanceof Error ? error.message : "The post could not be copied.");
    }
  }

  async function leaveToPosts() {
    if (dirty) await save();
    onBack();
  }

  const accountsById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const groupedAccounts = useMemo(() => {
    const groups = new Map<string, Account[]>();
    for (const account of accounts) {
      const key = account.identifier || "other";
      groups.set(key, [...(groups.get(key) || []), account]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [accounts]);

  const targets: PostTarget[] = post?.targets ?? targetIds.map((integrationId) => ({
    integrationId,
    platform: accountsById.get(integrationId)?.identifier || "",
    accountName: accountsById.get(integrationId)?.name || integrationId,
    status: "not_started" as const,
    snapshotVersion: 0,
    postizPostId: null,
    auditId: null,
    warning: null,
    error: null,
    submittedAt: null
  }));

  const trimmedContent = content.trim();
  const hasImage = Boolean(image);

  /** Per-account blockers; each one only ever gates its own account. */
  function targetBlocker(target: PostTarget): string {
    if (!trimmedContent) return t("Add post text before submitting.");
    const rule = platformRuleFor(target.platform);
    if (rule && content.length > rule.maxCharacters) {
      return `${t("Longer than this platform's limit")} (${rule.maxCharacters})`;
    }
    if (rule?.requiresImage && !hasImage) return t("This platform requires an image.");
    return "";
  }

  const pendingPushIds = targets
    .filter((target) => (target.status === "not_started" || target.status === "failed") && !submitting.includes(target.integrationId))
    .map((target) => target.integrationId);

  const previewAsset: ContentAsset = {
    id: post?.id ?? "draft",
    platform: previewPlatform,
    assetType: "short post",
    title: title || t("Untitled post"),
    content,
    imageUrl: image || undefined,
    factIds: [],
    riskFlags: [],
    updatedAt: new Date().toISOString()
  };

  const previewPlatforms = useMemo(() => {
    const selected = targets.map((target) => target.platform).filter((platform): platform is Platform => isSupportedPlatform(platform));
    return selected.length ? [...new Set(selected)] : (["x"] as Platform[]);
  }, [targets]);

  if (loading) {
    return (
      <section className="post-editor" aria-busy="true">
        <div className="post-editor-loader"><Loader2 className="spin" size={20} aria-hidden="true" /> {t("Loading post…")}</div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="post-editor">
        <div className="posts-empty">
          <span className="posts-empty-icon"><AlertTriangle size={24} aria-hidden="true" /></span>
          <h3>{t("This post could not be opened")}</h3>
          <p>{t(loadError)}</p>
          <button type="button" className="secondary-button" onClick={() => void onBack()}>{t("Back to posts")}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="post-editor" aria-labelledby="post-editor-title">
      <header className="post-editor-head">
        <button type="button" className="post-editor-back" onClick={() => void leaveToPosts()}>
          <ArrowLeft size={15} aria-hidden="true" /> {t("Posts")}
        </button>
        <div className="post-editor-title-block">
          <div className="eyebrow">{t("MANUAL POST")}</div>
          <h1 id="post-editor-title">{title.trim() || t("Untitled post")}</h1>
          <div className="post-editor-save-state" role="status">
            {saving ? <><Loader2 className="spin" size={12} aria-hidden="true" /> {t("Saving…")}</>
              : saveError ? <><AlertTriangle size={12} aria-hidden="true" /> {t("Save failed")}</>
                : dirty ? t("Unsaved changes")
                  : post ? <><CheckCircle2 size={12} aria-hidden="true" /> {t("Saved")} {formatPostTimestamp(post.updatedAt)}</>
                    : t("New post")}
          </div>
        </div>
        <div className="post-editor-actions">
          {post && (
            <button type="button" className="secondary-button" onClick={() => void copyAsNewDraft()}>
              <Copy size={14} aria-hidden="true" /> {t("Copy as new draft")}
            </button>
          )}
          <button type="button" className="secondary-button" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={14} aria-hidden="true" /> {t("Save draft")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!pendingPushIds.length || saving || Boolean(submitting.length) || !post}
            onClick={() => void pushTargets(pendingPushIds)}
          >
            {submitting.length ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
            {submitting.length ? t("Submitting…") : t("Push drafts")}
          </button>
        </div>
      </header>

      {!editable && (
        <div className="info-banner frozen" role="status">
          <ShieldCheck size={17} aria-hidden="true" />
          <div>
            <strong>{t("This post is read-only.")}</strong>{" "}
            {post?.frozenReason === "pending_unknown"
              ? t("A submission result is unconfirmed. Check Postiz before changing anything.")
              : post?.frozenReason === "submitting"
                ? t("A submission is running. This view unlocks only while no draft exists in Postiz.")
                : t("A draft already exists in Postiz for at least one account, so the local copy stays as it was submitted. Copy it as a new draft to change the text.")}
            <div className="frozen-actions">
              <button type="button" className="secondary-button" onClick={() => void copyAsNewDraft()}><Copy size={13} aria-hidden="true" /> {t("Copy as new draft")}</button>
              {isAdmin && postizUiUrl && <a className="text-button" href={postizUiUrl} target="_blank" rel="noopener noreferrer">{t("Open Postiz")} <ExternalLink size={13} aria-hidden="true" /></a>}
            </div>
          </div>
        </div>
      )}
      {frozenNotice && <div className="info-banner" role="status"><AlertTriangle size={16} aria-hidden="true" /><div>{t(frozenNotice)}</div></div>}
      {conflict && (
        <div className="info-banner" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{t("This post changed in another tab. Reload it before saving; your local edits in this tab will be replaced.")} <button type="button" className="text-button" onClick={() => void reloadPost()}>{t("Reload post")}</button></div>
        </div>
      )}
      {saveError && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(saveError)}</div></div>}
      {submitError && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(submitError)}</div></div>}
      {copiedNotice && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(copiedNotice)}</div></div>}
      {accountsError && (
        <div className="info-banner" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{t("The account list is unavailable. Submission is paused until accounts can be verified.")} <button type="button" className="text-button" onClick={onRefreshAccounts}>{t("Retry")}</button></div>
        </div>
      )}

      <div className="post-editor-columns">
        <div className="post-editor-column">
          <label className="field-label" htmlFor="post-editor-internal-title">
            {t("Internal title")} <span className="optional">{t("Only visible in Polaris; never sent to Postiz")}</span>
            <input
              id="post-editor-internal-title"
              value={title}
              maxLength={POST_TITLE_MAX_LENGTH}
              disabled={!editable}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("e.g. Gold regulation launch — X post")}
            />
          </label>

          <label className="field-label post-editor-content" htmlFor="post-editor-content">
            {t("Post text")}
            <textarea
              id="post-editor-content"
              value={content}
              maxLength={POST_CONTENT_MAX_LENGTH}
              disabled={!editable}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t("Write the post exactly as it should appear.")}
              rows={10}
            />
          </label>
          <div className="post-editor-counter">
            <span>{content.length.toLocaleString()} {t("characters")}</span>
            {previewPlatforms.map((platform) => {
              const rule = platformRuleFor(platform);
              if (!rule) return null;
              const over = content.length > rule.maxCharacters;
              return <span key={platform} className={over ? "over" : ""}>{PLATFORM_META[platform].label}: {content.length.toLocaleString()} / {rule.maxCharacters.toLocaleString()}</span>;
            })}
          </div>

          <AssetImageEditor
            value={image}
            title={title}
            disabled={!editable}
            allowUrlInput={false}
            urlSourceLabel="Saved image"
            onChange={(nextImage) => {
              setImage(nextImage);
              setImageDirty(true);
            }}
            onBusyChange={setImageBusy}
          />

          <section className="post-editor-preview" aria-label={t("Platform preview")}>
            <div className="post-editor-preview-head">
              <span className="eyebrow">{t("PREVIEW")}</span>
              <div className="post-editor-preview-tabs">
                {previewPlatforms.map((platform) => (
                  <button
                    key={platform}
                    type="button"
                    className={`posts-status-tab ${previewPlatform === platform ? "active" : ""}`}
                    onClick={() => setPreviewPlatform(platform)}
                  >
                    {t(PLATFORM_META[platform].label)}
                  </button>
                ))}
              </div>
            </div>
            <p className="post-editor-preview-note">{t("Simulated layout for this account. It is not real engagement data.")}</p>
            {content.trim() || hasImage ? (
              <SocialPreview
                asset={previewAsset}
                imageUrl={image || undefined}
                authorName={targets.find((target) => isSupportedPlatform(target.platform) && target.platform === previewPlatform)?.accountName || "Polaris Insights"}
              />
            ) : (
              <div className="post-editor-preview-empty"><ImageOff size={20} aria-hidden="true" /> {t("The preview appears once the post has text or an image.")}</div>
            )}
          </section>
        </div>

        <aside className="post-editor-aside">
          <section className="post-editor-panel" aria-labelledby="post-editor-accounts-title">
            <div className="post-editor-panel-head">
              <h2 id="post-editor-accounts-title">{t("Accounts")}</h2>
              <span className="post-editor-count">{targetIds.length} / {MAX_POST_TARGETS}</span>
            </div>
            <p className="post-editor-panel-note">{t("Each selected account receives its own Postiz draft of the same text and image.")}</p>
            {accountsLoading && !accounts.length ? (
              <div className="post-editor-accounts-loading"><Loader2 className="spin" size={15} aria-hidden="true" /> {t("Loading accounts…")}</div>
            ) : accounts.length ? (
              <div className="post-editor-account-groups">
                {groupedAccounts.map(([platform, groupAccounts]) => {
                  const meta = PLATFORM_META[platform as Platform];
                  return (
                    <div className="post-editor-account-group" key={platform}>
                      <div className="post-editor-account-group-label"><span className="posts-platform-mark" style={{ "--chip-accent": meta?.accent || "#71717a" } as React.CSSProperties}>{meta?.short || platform.slice(0, 2).toUpperCase()}</span> {platform || t("Other")}</div>
                      {groupAccounts.map((account) => {
                        const selected = targetIds.includes(account.id);
                        const locked = !editable || account.disabled;
                        return (
                          <label key={account.id} className={`post-editor-account ${selected ? "selected" : ""} ${account.disabled ? "disabled" : ""}`}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={locked || (!selected && targetIds.length >= MAX_POST_TARGETS)}
                              onChange={(event) => {
                                setTargetIds((current) => event.target.checked
                                  ? [...new Set([...current, account.id])]
                                  : current.filter((id) => id !== account.id));
                              }}
                            />
                            <span className="post-editor-account-copy">
                              <strong>{account.name}</strong>
                              <small>{account.disabled ? t("Needs reconnect in Postiz") : account.identifier || t("Other")}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="post-editor-accounts-empty">
                <p>{t("No accounts are available yet. Connect a platform, or ask an administrator to assign one.")}</p>
                <button type="button" className="secondary-button" onClick={onOpenAccounts}>{t("Open accounts")}</button>
              </div>
            )}
          </section>

          <section className="post-editor-panel" aria-labelledby="post-editor-targets-title">
            <div className="post-editor-panel-head">
              <h2 id="post-editor-targets-title">{t("Draft hand-off")}</h2>
            </div>
            <p className="post-editor-panel-note draft-note">{t("Pushing only creates a Postiz draft. Nothing is published or scheduled.")}</p>
            {targets.length ? (
              <ul className="post-editor-targets">
                {targets.map((target) => {
                  const isSubmitting = submitting.includes(target.integrationId) || target.status === "submitting";
                  const blocker = targetBlocker(target);
                  const meta = PLATFORM_META[target.platform as Platform];
                  const canRetry = target.status === "not_started" || target.status === "failed";
                  return (
                    <li key={target.integrationId} className={`post-editor-target ${target.status}`}>
                      <div className="post-editor-target-head">
                        <span className="posts-platform-mark" style={{ "--chip-accent": meta?.accent || "#71717a" } as React.CSSProperties}>{meta?.short || (target.platform || "?").slice(0, 2).toUpperCase()}</span>
                        <span className="post-editor-target-name">
                          <strong>{target.accountName || target.integrationId}</strong>
                          <small className={`target-state ${target.status}`}>{t(POST_TARGET_STATUS_LABEL[target.status])}</small>
                        </span>
                      </div>
                      {target.status === "accepted" && (
                        <div className="post-editor-target-meta">
                          {target.postizPostId ? <span>{t("Postiz draft")}: <code>{target.postizPostId}</code></span> : <span>{t("Accepted without a tracking ID; check Postiz before resubmitting.")}</span>}
                          {target.submittedAt && <span>{formatPostTimestamp(target.submittedAt)}</span>}
                        </div>
                      )}
                      {target.status === "pending_unknown" && <div className="post-editor-target-warning">{t("Result unconfirmed. Open Postiz and check before doing anything else.")}</div>}
                      {target.status === "failed" && target.error && <div className="post-editor-target-error">{target.error}</div>}
                      {target.warning && target.status !== "pending_unknown" && <div className="post-editor-target-warning">{target.warning}</div>}
                      {blocker && canRetry && <div className="post-editor-target-warning">{blocker}</div>}
                      {canRetry && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={isSubmitting || Boolean(blocker)}
                          onClick={() => void pushTargets([target.integrationId])}
                        >
                          {isSubmitting ? <><Loader2 className="spin" size={13} aria-hidden="true" /> {t("Submitting…")}</> : <><Send size={13} aria-hidden="true" /> {target.status === "failed" ? t("Retry this account") : t("Submit to Postiz draft")}</>}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="post-editor-targets-empty">{t("Select at least one account to enable the hand-off.")}</p>
            )}
            <div className="post-editor-aside-foot">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>{t("Drafts wait for review inside Postiz. Publishing stays a human decision there.")}</span>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
