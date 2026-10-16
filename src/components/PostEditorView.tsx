"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Save,
  Send,
  ShieldCheck
} from "lucide-react";
import { LocaleContext, translate } from "@/lib/i18n";
import AssetImageEditor from "@/components/AssetImageEditor";
import PostAccountPicker from "@/components/PostAccountPicker";
import { PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";
import {
  POST_CONTENT_MAX_LENGTH,
  POST_TARGET_STATUS_LABEL,
  formatPostTimestamp,
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
  const [preparingPush, setPreparingPush] = useState(false);
  const pushFlight = useRef(false);
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
      setTargetIds([]);
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
  const controlsLocked = !editable || preparingPush || Boolean(submitting.length);

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
    if (!editable || !dirty || loading || conflict || imageBusy || preparingPush || submitting.length) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [editable, dirty, loading, conflict, imageBusy, preparingPush, submitting.length, save, title, content, image, imageDirty, targetIds, postId]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (dirty || saving || preparingPush || submitting.length) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, saving, preparingPush, submitting.length]);

  const pushTargets = useCallback(async (integrationIds: string[]) => {
    if (!integrationIds.length || pushFlight.current || accountsLoading || accountsError || imageBusy || conflict) return;
    pushFlight.current = true;
    setPreparingPush(true);
    setSubmitError("");
    setFrozenNotice("");
    let saved = await save();
    // An older autosave may have been in flight when the push was clicked. Flush the latest
    // snapshot before submitting so selected accounts never receive an earlier edit.
    const latest = payloadRef.current;
    const latestKey = JSON.stringify([latest.title, latest.content, latest.imageDirty, [...latest.targetIds].sort().join(",")]);
    if (saved && latestKey !== savedPayload.current) saved = await save();
    if (!saved) {
      setSubmitError(t("Save the post before submitting it."));
      pushFlight.current = false;
      setPreparingPush(false);
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
    pushFlight.current = false;
    setPreparingPush(false);
    onSaved();
  }, [save, onSaved, reloadPost, t, accountsLoading, accountsError, imageBusy, conflict]);

  async function copyAsNewDraft() {
    const current = postRef.current;
    if (!current || pushFlight.current || imageBusy || saving) return;
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
    if (dirty && !await save()) return;
    onBack();
  }

  const accountsById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const targets: PostTarget[] = targetIds.map((integrationId) => post?.targets.find(target => target.integrationId === integrationId) ?? ({
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
    if (rule?.requiresImage && !hasImage) return t("This platform requires an image.");
    return "";
  }

  const pendingPushIds = targets
    .filter((target) => (target.status === "not_started" || target.status === "failed") && !submitting.includes(target.integrationId) && !targetBlocker(target))
    .map((target) => target.integrationId);

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
        <button type="button" className="post-editor-back" aria-label={t("Back to posts")} disabled={preparingPush || imageBusy || Boolean(submitting.length)} onClick={() => void leaveToPosts()}>
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <div className="post-editor-title-block">
          <h1 id="post-editor-title">{t(post ? "Edit post" : "New post")}</h1>
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
            <button type="button" className="secondary-button" disabled={preparingPush || imageBusy || saving || Boolean(submitting.length)} onClick={() => void copyAsNewDraft()}>
              <Copy size={14} aria-hidden="true" /> {t("Copy as new draft")}
            </button>
          )}
          <button type="button" className="secondary-button" disabled={!editable || !dirty || saving || imageBusy || preparingPush || Boolean(submitting.length) || conflict} onClick={() => void save()}>
            <Save size={14} aria-hidden="true" /> {t("Save draft")}
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
              <button type="button" className="secondary-button" disabled={preparingPush || imageBusy || saving || Boolean(submitting.length)} onClick={() => void copyAsNewDraft()}><Copy size={13} aria-hidden="true" /> {t("Copy as new draft")}</button>
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
          <div className="post-composer-surface">
            <label className="post-composer-sr-only" htmlFor="post-editor-content">{t("Post text")}</label>
            <textarea
              id="post-editor-content"
              className="post-composer-textarea"
              value={content}
              maxLength={POST_CONTENT_MAX_LENGTH}
              disabled={controlsLocked}
              onChange={event => setContent(event.target.value)}
              placeholder={t("Write the post exactly as it should appear.")}
              rows={7}
            />
            <AssetImageEditor
              variant="composer"
              value={image}
              title={t("Post image")}
              disabled={controlsLocked}
              allowUrlInput={false}
              onChange={nextImage => {
                setImage(nextImage);
                setImageDirty(true);
              }}
              onBusyChange={setImageBusy}
            />
          </div>
          <PostAccountPicker
            accounts={accounts}
            selectedIds={targetIds}
            disabled={controlsLocked}
            loading={accountsLoading}
            onChange={setTargetIds}
            onOpenAccounts={onOpenAccounts}
          />
        </div>

        <aside className="post-editor-aside">
          <section className="post-editor-panel" aria-labelledby="post-editor-targets-title">
            <div className="post-editor-panel-head">
              <h2 id="post-editor-targets-title">{t("Send drafts to")}</h2>
            </div>
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
                      {target.status === "failed" && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={preparingPush || isSubmitting || Boolean(submitting.length) || imageBusy || accountsLoading || Boolean(accountsError) || conflict || Boolean(blocker)}
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
              <p className="post-editor-targets-empty">{t("No accounts selected yet.")}</p>
            )}
            <div className="post-draft-destination"><ShieldCheck size={15} aria-hidden="true" /><span>{t("Destination")}<strong>{t("Postiz drafts")}</strong></span></div>
            <button type="button" className="primary-button post-push-drafts"
            disabled={!pendingPushIds.length || preparingPush || imageBusy || Boolean(submitting.length) || accountsLoading || Boolean(accountsError) || conflict}
              onClick={() => void pushTargets(pendingPushIds)}>
              {preparingPush || submitting.length ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
              {preparingPush || submitting.length ? t("Submitting…") : t("Push drafts to Postiz")}
            </button>
            <div className="post-editor-aside-foot">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>{t("Pushing only creates a Postiz draft. Nothing is published or scheduled.")}</span>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
