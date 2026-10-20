"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { LocaleContext, translate } from "@/lib/i18n";
import AssetImageEditor from "@/components/AssetImageEditor";
import PostAccountPicker from "@/components/PostAccountPicker";
import { PLATFORM_META, type Platform, type SocialAccount } from "@/lib/types";
import {
  POST_CONTENT_MAX_LENGTH,
  POST_TARGET_STATUS_LABEL,
  formatPostTimestamp,
  isTargetSetEditable,
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
type DeletionOperation = { phase: "idle" | "pending" | "deleted" } | { phase: "failed"; error: string };

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
  onRefreshAccounts,
  onDeletionPendingChange
}: {
  /** "new" starts an empty composer; the URL is upgraded to the saved id by onOpened. */
  postId: string | "new";
  accounts: Account[];
  accountsLoading: boolean;
  accountsError: string;
  postizUiUrl: string;
  isAdmin: boolean;
  onBack: () => void;
  onOpened: (postId: string, newSession?: boolean) => void;
  onSaved: () => void;
  onOpenAccounts: () => void;
  onRefreshAccounts: () => void;
  onDeletionPendingChange?: (pending: boolean) => void;
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
  const [copying, setCopying] = useState(false);
  const copyFlight = useRef(false);
  const operationEpoch = useRef(0);
  const statusRequest = useRef<AbortController | null>(null);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");
  const editorMounted = useRef(false);
  useEffect(() => {
    editorMounted.current = true;
    return () => { editorMounted.current = false; };
  }, []);
  const [deletion, setDeletion] = useState<DeletionOperation>({ phase: "idle" });
  const deletionOperation = useRef(deletion);
  const deletionBlocked = deletion.phase === "pending" || deletion.phase === "deleted";

  const updateDeletion = useCallback((operation: DeletionOperation) => {
    deletionOperation.current = operation;
    setDeletion(operation);
    onDeletionPendingChange?.(operation.phase === "pending");
  }, [onDeletionPendingChange]);

  useEffect(() => () => onDeletionPendingChange?.(false), [onDeletionPendingChange]);

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

  // Upgrading "new" to its saved id keeps this editor and its in-flight operation intact.
  useEffect(() => {
    if (postId === "new") {
      updateDeletion({ phase: "idle" });
      setPost(null); postRef.current = null; versionRef.current = 0;
      setTitle(""); setContent(""); setImage(""); setImageDirty(false); setImageName("");
      setTargetIds([]);
      savedPayload.current = JSON.stringify(["", "", false, ""]);
      setSavedRevision((revision) => revision + 1);
      setLoading(false); setLoadError(""); setConflict(false); setSaveError(""); setSubmitError(""); setFrozenNotice("");
      return;
    }
    if (postRef.current?.id === postId) return;
    updateDeletion({ phase: "idle" });
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
  }, [postId, applyDetail, updateDeletion]);

  const payloadKey = useMemo(
    () => JSON.stringify([title, content, imageDirty, [...targetIds].sort().join(",")]),
    [title, content, imageDirty, targetIds]
  );
  // Save results live in a ref, so the re-render that setSavedRevision triggers is what makes this
  // comparison visible to the next render; savedRevision itself is not read here on purpose.
  const dirty = payloadKey !== savedPayload.current;
  void savedRevision;
  const editable = post ? post.editable : true;
  const controlsLocked = !editable || preparingPush || Boolean(submitting.length) || deletionBlocked || copying;
  const canDelete = editable && !post?.frozenReason && (!post || post.targets.every(target => target.status === "not_started" || target.status === "failed"));

  const refreshStatus = useCallback(async (quiet = true) => {
    const current = postRef.current;
    const operationPending = () => Boolean(saveFlight.current || pushFlight.current || copyFlight.current
      || deletionOperation.current.phase === "pending" || deletionOperation.current.phase === "deleted");
    if (!current || document.hidden || statusRequest.current || operationPending()) return;
    const controller = new AbortController();
    statusRequest.current = controller;
    const epoch = operationEpoch.current;
    const targetBindings = JSON.stringify(current.targets.map(target => [target.integrationId, target.auditId, target.postizPostId, target.status]));
    if (!quiet) setRefreshingStatus(true);
    try {
      const response = await fetch(`/api/posts/${current.id}`, { cache: "no-store", signal: controller.signal });
      const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
      const latest = postRef.current;
      if (!editorMounted.current || controller.signal.aborted || epoch !== operationEpoch.current || operationPending()
        || latest !== current || versionRef.current !== current.version
        || targetBindings !== JSON.stringify(latest.targets.map(target => [target.integrationId, target.auditId, target.postizPostId, target.status]))) return;
      if (!response.ok || !data.post) throw new Error(data.error || "The post could not be reloaded.");
      const serverPost = data.post;
      if (serverPost.id !== current.id || serverPost.version < current.version) return;
      // Refresh delivery state only. Keep local fields, account selection, dirty baseline and the
      // content version used by PATCH: a different tab's edits must still cause a save conflict.
      const detail: ManualPostDetail = {
        ...current,
        editable: serverPost.editable,
        frozenReason: serverPost.frozenReason,
        updatedAt: serverPost.updatedAt,
        targets: current.targets.map(target => serverPost.targets.find(candidate => candidate.integrationId === target.integrationId) ?? target)
      };
      postRef.current = detail;
      setPost(detail);
      if (!quiet) setStatusError("");
    } catch (error) {
      if (!quiet && editorMounted.current && !controller.signal.aborted && epoch === operationEpoch.current) {
        setStatusError(error instanceof Error ? error.message : "The post could not be reloaded.");
      }
    } finally {
      if (statusRequest.current === controller) statusRequest.current = null;
      if (!quiet && editorMounted.current) setRefreshingStatus(false);
    }
  }, []);

  const shouldPollStatus = Boolean(post?.targets.some(target => ["accepted", "rejected", "submitting", "pending_unknown"].includes(target.status)));
  useEffect(() => {
    if (!shouldPollStatus) return;
    const refresh = () => { void refreshStatus(); };
    const timer = window.setInterval(refresh, post?.targets.some(target => target.status === "submitting") ? 3_000 : 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      statusRequest.current?.abort();
      statusRequest.current = null;
    };
  }, [shouldPollStatus, refreshStatus, post?.targets]);

  const reloadPost = useCallback(async (resetFields = true) => {
    const current = postRef.current;
    if (!current) return;
    operationEpoch.current += 1;
    try {
      const response = await fetch(`/api/posts/${current.id}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
      if (!response.ok || !data.post) throw new Error(data.error || "The post could not be reloaded.");
      applyDetail(data.post, { resetFields });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The post could not be reloaded.");
    } finally {
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
    if (editorMounted.current) onOpened(detail.id);
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
        await reloadPost(deletionOperation.current.phase !== "pending");
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
    if (copyFlight.current) return null;
    if (deletionOperation.current.phase === "pending" || deletionOperation.current.phase === "deleted") return null;
    if (saveFlight.current) return saveFlight.current;
    const flight = (async (): Promise<ManualPostDetail | null> => {
      const payload = payloadRef.current;
      const key = JSON.stringify([payload.title, payload.content, payload.imageDirty, [...payload.targetIds].sort().join(",")]);
      const current = postRef.current;
      if (current && !current.editable) return current;
      if (key === savedPayload.current) return current;
      operationEpoch.current += 1;
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
    if (copying || deletionBlocked || !editable || !dirty || loading || conflict || imageBusy || preparingPush || submitting.length) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [copying, deletionBlocked, editable, dirty, loading, conflict, imageBusy, preparingPush, submitting.length, save, title, content, image, imageDirty, targetIds, postId]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (deletion.phase !== "deleted" && (dirty || saving || preparingPush || submitting.length || deletionBlocked)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [deletion.phase, deletionBlocked, dirty, saving, preparingPush, submitting.length]);

  const pushTargets = useCallback(async (integrationIds: string[]) => {
    if (copyFlight.current) return;
    if (deletionOperation.current.phase === "pending" || deletionOperation.current.phase === "deleted") return;
    if (!integrationIds.length || pushFlight.current || accountsLoading || accountsError || imageBusy || conflict) return;
    const shownTargets = new Map(postRef.current?.targets.map(target => [target.integrationId, target]));
    operationEpoch.current += 1;
    pushFlight.current = true;
    onDeletionPendingChange?.(true);
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
      onDeletionPendingChange?.(false);
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
            body: JSON.stringify({
              expectedVersion: versionRef.current,
              ...(shownTargets.get(integrationId)?.status === "rejected"
                ? { expectedAuditId: shownTargets.get(integrationId)?.auditId }
                : {})
            })
          });
          const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string; code?: string };
          if (response.ok && data.post) {
            if (response.status === 202) setFrozenNotice(t("Submission accepted. Processing in the background; you can close this dialog or leave this page."));
            const current = postRef.current;
            const returnedTarget = data.post.targets.find(target => target.integrationId === integrationId);
            if (!current || current.id !== saved.id || !returnedTarget || !editorMounted.current) continue;
            // Parallel submissions return whole-post snapshots. Only this account's result belongs
            // to this response; sibling states may already be newer than its server snapshot.
            const mergedTargets = current.targets.map(target => target.integrationId === integrationId ? returnedTarget : target);
            const frozenReason = (["accepted", "rejected", "submitting", "pending_unknown"] as const)
              .find(status => mergedTargets.some(target => target.status === status)) ?? null;
            const detail: ManualPostDetail = {
              ...current, targets: mergedTargets, editable: isTargetSetEditable(mergedTargets), frozenReason,
              updatedAt: data.post.updatedAt, version: Math.max(current.version, data.post.version)
            };
            setPost(detail); postRef.current = detail; versionRef.current = detail.version;
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
    onDeletionPendingChange?.(false);
    onSaved();
  }, [save, onSaved, reloadPost, t, accountsLoading, accountsError, imageBusy, conflict, onDeletionPendingChange]);

  async function copyAsNewDraft() {
    if (deletionBlocked || copyFlight.current) return;
    const current = postRef.current;
    if (!current || pushFlight.current || imageBusy || saving) return;
    operationEpoch.current += 1;
    copyFlight.current = true;
    setCopying(true);
    setCopiedNotice("");
    try {
      const response = await fetch(`/api/posts/${current.id}/duplicate`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { post?: ManualPostDetail; error?: string };
      if (!response.ok || !data.post) throw new Error(data.error || "The post could not be copied.");
      if (editorMounted.current) onOpened(data.post.id, true);
    } catch (error) {
      setCopiedNotice(error instanceof Error ? error.message : "The post could not be copied.");
    } finally {
      copyFlight.current = false;
      setCopying(false);
    }
  }

  async function leaveToPosts() {
    if (deletionBlocked || copyFlight.current) return;
    if (dirty && !await save()) return;
    onBack();
  }

  async function deleteDraft() {
    if (copyFlight.current) return;
    if (deletionOperation.current.phase === "pending" || deletionOperation.current.phase === "deleted" || !canDelete || pushFlight.current || imageBusy) return;
    if (!postRef.current && !saveFlight.current) return;
    if (!window.confirm(t("Delete this local draft permanently? Nothing has been sent to Postiz for it."))) return;
    operationEpoch.current += 1;
    updateDeletion({ phase: "pending" });
    try {
      // Let an existing create/PATCH settle; never save newer edits just to discard them.
      await saveFlight.current;
      const current = postRef.current;
      if (!current) throw new Error("The draft has not been saved. Keep editing or try saving again.");
      if (!current.editable || current.frozenReason || current.targets.some(target => target.status !== "not_started" && target.status !== "failed")) {
        throw new Error("This post is read-only. It cannot be deleted here.");
      }
      const response = await fetch(`/api/posts/${current.id}`, { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!response.ok) {
        if (data.code === "POST_FROZEN") await reloadPost(false);
        throw new Error(data.error || "The post could not be deleted.");
      }
      // Keep autosave parked until navigation unmounts this editor.
      updateDeletion({ phase: "deleted" });
      onSaved();
      onBack();
    } catch (error) {
      updateDeletion({ phase: "failed", error: error instanceof Error ? error.message : "The post could not be deleted." });
    }
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

  const trimmedContent = (editable ? content : post?.content ?? content).trim();
  const hasImage = Boolean(editable ? image : post?.imageUrl);

  /** Per-account blockers; each one only ever gates its own account. */
  function targetBlocker(target: PostTarget): string {
    if (!trimmedContent) return t("Add post text before submitting.");
    const rule = platformRuleFor(target.platform);
    if (rule?.requiresImage && !hasImage) return t("This platform requires an image.");
    return "";
  }

  const pendingPushIds = targets
    .filter((target) => editable || post?.targets.some(savedTarget => savedTarget.integrationId === target.integrationId))
    .filter((target) => (target.status === "not_started" || target.status === "failed" || (target.status === "rejected" && Boolean(target.auditId))) && !submitting.includes(target.integrationId) && !targetBlocker(target))
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
        <button type="button" className="post-editor-back" aria-label={t("Back to posts")} disabled={copying || deletionBlocked || preparingPush || imageBusy || Boolean(submitting.length)} onClick={() => void leaveToPosts()}>
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
          {shouldPollStatus && (
            <button type="button" className="secondary-button" disabled={refreshingStatus || copying || deletionBlocked || preparingPush || saving || imageBusy || Boolean(submitting.length)} onClick={() => void refreshStatus(false)}>
              <RefreshCw size={14} className={refreshingStatus ? "spin" : undefined} aria-hidden="true" /> {t("Refresh status")}
            </button>
          )}
          {canDelete && (post || saving) && (
            <button type="button" className="secondary-button danger" disabled={copying || deletionBlocked || preparingPush || imageBusy || Boolean(submitting.length)} onClick={() => void deleteDraft()}>
              {deletion.phase === "pending" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
              {t(deletion.phase === "pending" ? "Deleting draft…" : "Delete draft")}
            </button>
          )}
          {post && (
            <button type="button" className="secondary-button" disabled={copying || deletionBlocked || preparingPush || imageBusy || saving || Boolean(submitting.length)} onClick={() => void copyAsNewDraft()}>
              <Copy size={14} aria-hidden="true" /> {t("Copy as new draft")}
            </button>
          )}
          <button type="button" className="secondary-button" disabled={controlsLocked || !dirty || saving || imageBusy || conflict} onClick={() => void save()}>
            <Save size={14} aria-hidden="true" /> {t("Save draft")}
          </button>
        </div>
      </header>

      {!editable && (
        <div className="info-banner frozen" role="status">
          <ShieldCheck size={17} aria-hidden="true" />
          <div>
            <strong>{t("This post is read-only.")}</strong>{" "}
            {post?.targets.some(target => target.status === "rejected")
              ? t("Review was rejected. The original post stays read-only. Resubmit the same content for review, or copy it as a new draft to make changes.")
              : post?.frozenReason === "pending_unknown"
              ? t("A submission result is unconfirmed. Check Postiz before changing anything.")
              : post?.frozenReason === "submitting"
                ? t("A submission is running. This view unlocks only while no draft exists in Postiz.")
                : t("A draft already exists in Postiz for at least one account, so the local copy stays as it was submitted. Copy it as a new draft to change the text.")}
            <div className="frozen-actions">
              <button type="button" className="secondary-button" disabled={copying || preparingPush || imageBusy || saving || Boolean(submitting.length)} onClick={() => void copyAsNewDraft()}><Copy size={13} aria-hidden="true" /> {t("Copy as new draft")}</button>
              {isAdmin && postizUiUrl && <a className="text-button" href={postizUiUrl} target="_blank" rel="noopener noreferrer">{t("Open Postiz")} <ExternalLink size={13} aria-hidden="true" /></a>}
            </div>
          </div>
        </div>
      )}
      {frozenNotice && <div className="info-banner" role="status"><AlertTriangle size={16} aria-hidden="true" /><div>{t(frozenNotice)}</div></div>}
      {conflict && (
        <div className="info-banner" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{t("This post changed in another tab. Reload it before saving; your local edits in this tab will be replaced.")} <button type="button" className="text-button" disabled={deletionBlocked} onClick={() => void reloadPost()}>{t("Reload post")}</button></div>
        </div>
      )}
      {saveError && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(saveError)}</div></div>}
      {submitError && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(submitError)}</div></div>}
      {statusError && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(statusError)}</div></div>}
      {copiedNotice && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(copiedNotice)}</div></div>}
      {deletion.phase === "pending" && <div className="info-banner" role="status">{t("Deleting draft…")}</div>}
      {deletion.phase === "failed" && <div className="info-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div>{t(deletion.error)}</div></div>}
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
            onOpenAccounts={() => { if (!deletionBlocked) onOpenAccounts(); }}
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
                  const canRetry = target.status === "not_started" || target.status === "failed" || target.status === "rejected";
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
                      {(target.status === "failed" || target.status === "rejected") && target.error && <div className="post-editor-target-error">{t(target.error)}</div>}
                      {target.warning && target.status !== "pending_unknown" && <div className="post-editor-target-warning">{t(target.warning)}</div>}
                      {blocker && canRetry && <div className="post-editor-target-warning">{blocker}</div>}
                      {(target.status === "failed" || target.status === "rejected") && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={copying || deletionBlocked || preparingPush || isSubmitting || Boolean(submitting.length) || imageBusy || accountsLoading || Boolean(accountsError) || conflict || Boolean(blocker) || (target.status === "rejected" && !target.auditId)}
                          onClick={() => void pushTargets([target.integrationId])}
                        >
                          {isSubmitting ? <><Loader2 className="spin" size={13} aria-hidden="true" /> {t("Submitting…")}</> : <><Send size={13} aria-hidden="true" /> {t(target.status === "rejected" ? "Resubmit for review" : "Retry this account")}</>}
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
            disabled={copying || deletionBlocked || !pendingPushIds.length || preparingPush || imageBusy || Boolean(submitting.length) || accountsLoading || Boolean(accountsError) || conflict}
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
