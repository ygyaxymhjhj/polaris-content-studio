"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { formatPostTimestamp, postPublicationLabel, type ManualPostDetail } from "@/lib/post-types";
import { SOCIAL_PLATFORM_META, type SocialPlatform } from "@/lib/types";

export default function SubmittedPostView({ postId, onBack }: { postId: string; onBack: () => void }) {
  const t = useTranslation();
  const [result, setResult] = useState<{ post: ManualPostDetail } | { error: string }>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const response = await fetch(`/api/posts/${encodeURIComponent(postId)}?scope=submitted`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (controller.signal.aborted) return;
        setResult(response.ok ? { post: data.post } : { error: data.error || "The post could not be loaded." });
      } catch {
        if (!controller.signal.aborted) setResult({ error: "The post could not be loaded." });
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [postId, refresh]);

  const post = result && "post" in result ? result.post : null;
  return <section className="post-editor" aria-labelledby="submitted-post-title">
    <header className="post-editor-head">
      <button className="secondary-button" type="button" onClick={onBack}>{t("Back to posts")}</button>
      <div className="post-editor-title-block">
        <h1 id="submitted-post-title">{post?.title || t("Submitted post")}</h1>
        <span className="eyebrow">{t("Read only")}</span>
      </div>
      <button className="secondary-button" type="button" onClick={() => setRefresh(value => value + 1)}>{t("Refresh")}</button>
    </header>
    {!result && <p role="status">{t("Loading post…")}</p>}
    {result && "error" in result && <p role="alert" className="error-banner">{t(result.error)}</p>}
    {post && <div className="post-editor-columns">
      <div className="post-editor-panel">
        <p className="post-editor-panel-note">{t("Submitted by")}: {post.ownerName || "—"}</p>
        <div className="submitted-post-body">{post.content || t("No text yet")}</div>
        {post.attachmentUrls?.map((url, index) => <Image key={url} className="submitted-post-media" src={url}
          alt={`${t("Post image")} ${index + 1}`} width={post.imageWidth || 720} height={post.imageHeight || 480} unoptimized />)}
        {post.videoUrl && <video className="submitted-post-media" src={post.videoUrl} controls preload="metadata" aria-label={t("Post video")} />}
      </div>
      <div className="post-editor-panel">
        <div className="post-editor-panel-head"><h2>{t("Post status")}</h2></div>
        {post.scheduledAt && <p className="post-editor-panel-note">{t("Scheduled at")}: {formatPostTimestamp(post.scheduledAt)}</p>}
        <ul className="post-editor-targets">
          {post.targets.map(target => {
            const platform = SOCIAL_PLATFORM_META[target.platform as SocialPlatform]?.label || target.platform;
            const style = target.publicationState === "ERROR" ? "failed" : target.status;
            return <li className={`post-editor-target ${style}`} key={target.integrationId}>
              <div className="post-editor-target-name">
                <strong>{platform} / {target.accountName}</strong>
                <small className={`target-state ${style}`}>{t(postPublicationLabel(target))}</small>
              </div>
              {target.publishedAt && <time dateTime={target.publishedAt}>{t("Published at")}: {formatPostTimestamp(target.publishedAt)}</time>}
              {target.publishedUrl && <a href={target.publishedUrl} target="_blank" rel="noopener noreferrer">{t("View published post")}</a>}
              {(target.publicationError || target.error) && <div className="post-editor-target-error">{t(target.publicationError || target.error || "")}</div>}
              {target.warning && <div className="post-editor-target-warning">{t(target.warning)}</div>}
            </li>;
          })}
        </ul>
      </div>
    </div>}
  </section>;
}
