"use client";

import { ChevronLeft, ChevronRight, CloudUpload, ImageOff, ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "@/lib/i18n";
import { ACCEPTED_IMAGE_TYPES, prepareUploadedImage, type PreparedImage } from "@/lib/image-upload";
import { getVideoPreviewUrl, type VideoProcessingJob } from "@/lib/video-types";
import { getImagePreviewUrl, MAX_POST_IMAGES } from "@/lib/image-types";
import { importLegacyImage, uploadImage } from "@/lib/image-upload-client";
import { resumeVideoProcessing, uploadVideo, validateVideoUpload, VideoProcessingStatusError, type VideoProcessingPhase } from "@/lib/video-upload-client";

interface AssetImageEditorProps {
  value: string;
  imageMediaIds?: string[];
  onImagesChange?: (ids: string[]) => void;
  videoMediaId?: string | null;
  onVideoChange?: (id: string | null) => void;
  originalImageUrl?: string;
  title: string;
  disabled?: boolean;
  /** Manual posts only accept uploaded files, so the URL input can be hidden. */
  allowUrlInput?: boolean;
  /** Label for a value that is neither an uploaded data URL nor the original article image. */
  urlSourceLabel?: string;
  variant?: "default" | "composer";
  onChange: (imageUrl: string) => void;
  onBusyChange: (busy: boolean) => void;
}

type ImageUploadItem = { file: File; status: "pending" | "uploading" | "succeeded" | "failed" | "cancelled"; error?: string };

export default function AssetImageEditor({
  value,
  imageMediaIds,
  onImagesChange,
  videoMediaId,
  onVideoChange,
  originalImageUrl,
  title,
  disabled = false,
  allowUrlInput = true,
  urlSourceLabel,
  variant = "default",
  onChange,
  onBusyChange
}: AssetImageEditorProps) {
  const t = useTranslation();
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);
  const uploadInProgress = useRef(false);
  const uploadController = useRef<AbortController | null>(null);
  const localPreview = useRef("");
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const [uploading, setUploading] = useState(false);
  const [videoPreview, setVideoPreview] = useState("");
  const [videoProgress, setVideoProgress] = useState<number | null>(null);
  const [videoProcessing, setVideoProcessing] = useState<VideoProcessingPhase | null>(null);
  const [recoverableJob, setRecoverableJob] = useState<VideoProcessingJob | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [failedPreviewUrl, setFailedPreviewUrl] = useState("");
  const [uploadedImage, setUploadedImage] = useState<PreparedImage | null>(null);
  const [imageUploads, setImageUploads] = useState<ImageUploadItem[]>([]);
  const mediaKey = JSON.stringify([imageMediaIds ?? null, imageMediaIds === undefined ? value : "", videoMediaId ?? null]);
  const latestMediaKey = useRef(mediaKey);
  latestMediaKey.current = mediaKey;
  const locked = disabled || uploading;
  const isEmbeddedImage = value.startsWith("data:image/");
  const currentUpload = uploadedImage?.dataUrl === value ? uploadedImage : null;
  const previewFailed = !!value && failedPreviewUrl === value;
  const sourceLabel = isEmbeddedImage
    ? t("Uploaded image")
    : value === originalImageUrl ? t("Article image") : urlSourceLabel ? t(urlSourceLabel) : t("Image link");
  const videoUrl = videoPreview || (videoMediaId ? getVideoPreviewUrl(videoMediaId) : "");
  const hasMedia = Boolean(imageMediaIds?.length || value || videoUrl);
  const imageCount = imageMediaIds === undefined ? Number(Boolean(value && !videoUrl)) : imageMediaIds.length;
  const acceptedTypes = [...ACCEPTED_IMAGE_TYPES, ...(onVideoChange ? ["video/mp4", ".mp4"] : [])].join(",");
  const inputLabel = t(onVideoChange ? "Upload post media" : "Upload post image");
  const mediaLabel = t(onVideoChange ? "Post media" : "Post image");
  const processingLabels: Record<VideoProcessingPhase, string> = {
    queued: "Video queued…", validating: "Validating video…", converting: "Converting video to H.264…", saving: "Saving video…"
  };
  const busyLabel = videoProgress === null ? t("Processing image…") : videoProcessing ? t(processingLabels[videoProcessing]) : videoProgress < 100
    ? `${t("Uploading video…")} ${videoProgress}%` : t("Video transferred. Waiting for processing…");
  const replaceLabel = t(videoUrl ? "Replace video" : "Replace image");
  const removeLabel = t(videoUrl ? "Remove video" : "Remove image");

  function clearLocalPreview() {
    if (localPreview.current) URL.revokeObjectURL(localPreview.current);
    localPreview.current = "";
    setVideoPreview("");
  }

  function cancelUpload() {
    // Invalidate first: abort can synchronously dispatch a completion event.
    uploadSequence.current += 1;
    uploadController.current?.abort();
    uploadController.current = null;
    uploadInProgress.current = false;
    clearLocalPreview();
    setUploading(false);
    setImageUploads(items => items.map(item => item.status === "pending" || item.status === "uploading" ? { ...item, status: "cancelled" } : item));
    setVideoProgress(null);
    setVideoProcessing(null);
    setRecoverableJob(null);
    busyCallback.current(false);
  }

  useEffect(() => () => {
    // A closed editor or an AI candidate must never receive a late file-read result.
    uploadSequence.current += 1;
    uploadController.current?.abort();
    if (localPreview.current) URL.revokeObjectURL(localPreview.current);
    uploadInProgress.current = false;
    busyCallback.current(false);
  }, []);

  async function uploadImages(imageFiles: File[], processingJob?: VideoProcessingJob) {
    if (disabled || uploadInProgress.current || (!processingJob && !imageFiles.length)) return;
    setUploadError("");
    if (!processingJob && onImagesChange && imageFiles.every(file => ACCEPTED_IMAGE_TYPES.includes(file.type))) {
      await uploadImageBatch(imageFiles.map(file => ({ file, status: "pending" })));
      return;
    }
    if (!processingJob && imageFiles.length !== 1) {
      setUploadError(t(onImagesChange ? "Choose images together or one MP4 video." : onVideoChange ? "Please upload one image or MP4 at a time." : "Please upload one image at a time."));
      return;
    }

    const file = imageFiles[0];
    const isVideo = Boolean(processingJob || (onVideoChange && !ACCEPTED_IMAGE_TYPES.includes(file.type)));
    if (isVideo && !processingJob) {
      try { validateVideoUpload(file); }
      catch (error) { setUploadError(t((error as Error).message)); return; }
    }
    const sequence = ++uploadSequence.current;
    const originalMediaKey = mediaKey;
    // Selecting other media explicitly abandons only the local recovery receipt, not another job.
    setRecoverableJob(null);
    uploadInProgress.current = true;
    setUploading(true);
    busyCallback.current(true);
    try {
      if (isVideo) {
        const controller = new AbortController();
        uploadController.current = controller;
        setVideoProgress(processingJob ? 100 : 0);
        setVideoProcessing(null);
        if (!processingJob) {
          localPreview.current = URL.createObjectURL(file);
          setVideoPreview(localPreview.current);
        }
        const updateProcessing = (phase: VideoProcessingPhase) => {
          if (sequence === uploadSequence.current) setVideoProcessing(phase);
        };
        const video = await (processingJob ? resumeVideoProcessing(processingJob, controller.signal, updateProcessing)
          : uploadVideo(file, controller.signal, progress => {
            if (sequence === uploadSequence.current) setVideoProgress(progress);
          }, updateProcessing));
        if (sequence !== uploadSequence.current || latestMediaKey.current !== originalMediaKey) return;
        onVideoChange?.(video.id);
        setImageUploads([]);
        setUploadedImage(null);
      } else {
        setVideoProgress(null);
        setVideoProcessing(null);
        const preparedImage = await prepareUploadedImage(file);
        if (sequence !== uploadSequence.current) return;
        setUploadedImage(preparedImage);
        setFailedPreviewUrl("");
        onChange(preparedImage.dataUrl);
      }
    } catch (error) {
      if (sequence !== uploadSequence.current) return;
      if (error instanceof Error && error.name === "AbortError") return;
      const message = t(error instanceof Error ? error.message : isVideo ? "Could not upload this video. Please try again." : "Could not process this image. Please try another file.");
      if (error instanceof VideoProcessingStatusError) setRecoverableJob(error.job);
      setUploadError(error instanceof VideoProcessingStatusError ? `${message} ${t("Video job ID:")} ${error.job.id}` : message);
    } finally {
      if (sequence === uploadSequence.current) {
        uploadInProgress.current = false;
        uploadController.current = null;
        clearLocalPreview();
        setUploading(false);
        setVideoProgress(null);
        setVideoProcessing(null);
        busyCallback.current(false);
      }
    }
  }

  async function uploadImageBatch(items: ImageUploadItem[]) {
    if (!onImagesChange || disabled || uploadInProgress.current) return;
    const pending = items.filter(item => item.status === "pending");
    if (imageCount + pending.length > MAX_POST_IMAGES) {
      setUploadError(t("Attach up to 10 images."));
      return;
    }
    const sequence = ++uploadSequence.current;
    const controller = new AbortController();
    uploadController.current = controller;
    uploadInProgress.current = true;
    let expectedKey = mediaKey;
    let ids = [...(imageMediaIds ?? [])];
    const active = () => sequence === uploadSequence.current && !controller.signal.aborted && latestMediaKey.current === expectedKey;
    const updateItem = (file: File, status: ImageUploadItem["status"], error?: string) => {
      setImageUploads(current => current.map(item => item.file === file ? { ...item, status, error } : item));
    };
    setImageUploads(items);
    setUploading(true);
    setUploadError("");
    setRecoverableJob(null);
    setVideoProgress(null);
    busyCallback.current(true);
    try {
      // Keep the legacy image visible until a new file also succeeds.
      if (imageMediaIds === undefined && value && !videoMediaId) {
        const legacy = await importLegacyImage(value, controller.signal);
        if (!active()) return;
        ids = [legacy.id];
      }
      for (const item of pending) {
        if (!active()) return;
        updateItem(item.file, "uploading");
        try {
          const image = await uploadImage(item.file, controller.signal);
          if (!active()) return;
          if (ids.some(id => id.toLowerCase() === image.id.toLowerCase())) {
            updateItem(item.file, "succeeded");
            continue;
          }
          ids = [...ids, image.id];
          expectedKey = JSON.stringify([ids, "", null]);
          latestMediaKey.current = expectedKey;
          onImagesChange(ids);
          updateItem(item.file, "succeeded");
        } catch (error) {
          if (!active()) return;
          updateItem(item.file, "failed", error instanceof Error ? error.message : "Could not upload this image. Please try again.");
        }
      }
    } catch (error) {
      if (active()) {
        const message = error instanceof Error ? error.message : "Could not upload this image. Please try again.";
        setImageUploads(current => current.map(item => item.status === "pending" ? { ...item, status: "failed", error: message } : item));
      }
    } finally {
      if (sequence === uploadSequence.current) {
        uploadController.current = null;
        uploadInProgress.current = false;
        setUploading(false);
        busyCallback.current(false);
      }
    }
  }

  function changeImage(imageUrl: string) {
    setImageUploads([]);
    setRecoverableJob(null);
    setUploadError("");
    setFailedPreviewUrl("");
    setUploadedImage(null);
    onChange(imageUrl);
  }

  function removeMedia() {
    setRecoverableJob(null);
    setUploadError("");
    if (videoMediaId) onVideoChange?.(null);
    else changeImage("");
  }

  const videoElement = videoUrl ? <video key={videoUrl} src={videoUrl} controls preload="metadata" playsInline aria-label={t("Post video")} /> : null;
  const uploadStatus = uploading ? <div className="asset-image-status asset-video-progress" role="status">
    <span>{busyLabel}</span>
    <button type="button" className="text-button" onClick={cancelUpload}>{t("Cancel upload")}</button>
  </div> : null;
  const recoveryAction = recoverableJob && !uploading ? <button type="button" className="text-button" disabled={locked}
    onClick={() => void uploadImages([], recoverableJob)}>{t("Retry processing status")}</button> : null;

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = locked ? "none" : "copy";
    if (!locked) setDragActive(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (!locked) void uploadImages(Array.from(event.dataTransfer.files));
  }

  if (onImagesChange) {
    const previews = imageMediaIds === undefined ? value && !videoUrl ? [value] : [] : imageMediaIds.map(id => getImagePreviewUrl(id, "thumb"));
    const changeOrder = (index: number, direction: number) => {
      if (locked || !imageMediaIds) return;
      const ids = [...imageMediaIds];
      [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
      onImagesChange(ids);
    };
    const canAdd = Boolean(videoUrl) || imageCount < MAX_POST_IMAGES;
    return <section className={variant === "composer" ? `post-composer-media${dragActive ? " is-dragging" : ""}` : "drawer-section asset-image-editor"}
      aria-label={mediaLabel} aria-busy={uploading} onDragOver={handleDragOver} onDragLeave={() => setDragActive(false)} onDrop={handleDrop}>
      {variant !== "composer" && <div className="asset-image-heading"><span className="field-label">{mediaLabel}</span>
        {originalImageUrl && (imageMediaIds !== undefined || value !== originalImageUrl || videoMediaId) && <button type="button" className="text-button asset-image-restore" disabled={locked} onClick={() => changeImage(originalImageUrl)}><RotateCcw size={13} aria-hidden="true" />{t("Restore article image")}</button>}
      </div>}
      <input ref={fileInput} type="file" multiple className="asset-image-file-input" accept={acceptedTypes} aria-label={inputLabel} disabled={locked} tabIndex={-1}
        onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void uploadImages(files); }} />
      <button type="button" className="secondary-button post-media-add" disabled={locked || !canAdd} onClick={() => fileInput.current?.click()}>
        {uploading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <CloudUpload size={14} aria-hidden="true" />}
        {uploading ? busyLabel : videoUrl ? replaceLabel : hasMedia ? t("Add images") : t("Add media")}
      </button>
      {(previews.length > 0 || videoElement) && <div className="post-media-attachments asset-image-grid">
        {videoElement ? <div className="post-media-thumbnail">{videoElement}<button type="button" className="post-media-remove" disabled={locked} aria-label={t("Remove video")} onClick={removeMedia}><Trash2 size={15} aria-hidden="true" /></button></div>
          : previews.map((url, index) => <div className="asset-image-grid-item" key={imageMediaIds?.[index] ?? url}>
            <div className="post-media-thumbnail"><Image src={url} alt={`${title || t("Post image")} ${index + 1}`} fill unoptimized sizes="144px" referrerPolicy="no-referrer" />
              <button type="button" className="post-media-remove" disabled={locked} aria-label={`${t("Remove image")} ${index + 1}`} onClick={() => imageMediaIds === undefined ? changeImage("") : onImagesChange(imageMediaIds.filter((_, position) => position !== index))}><Trash2 size={15} aria-hidden="true" /></button>
            </div>
            <div className="asset-image-order"><span>{index + 1}</span><button type="button" disabled={locked || index === 0} aria-label={`${t("Move image left")} ${index + 1}`} onClick={() => changeOrder(index, -1)}><ChevronLeft size={16} aria-hidden="true" /></button><button type="button" disabled={locked || index === previews.length - 1} aria-label={`${t("Move image right")} ${index + 1}`} onClick={() => changeOrder(index, 1)}><ChevronRight size={16} aria-hidden="true" /></button></div>
          </div>)}
        {canAdd && <button type="button" className="post-media-replace" disabled={locked} aria-label={t(videoUrl ? "Replace video" : "Add images")} onClick={() => fileInput.current?.click()}><ImagePlus size={22} aria-hidden="true" /></button>}
      </div>}
      {imageCount > 0 && <div className="asset-image-status">{imageCount} / {MAX_POST_IMAGES} {t("images")}</div>}
      {imageUploads.some(item => item.status !== "succeeded") && <ul className="asset-image-upload-list" aria-label={t("Image uploads")}>
        {imageUploads.filter(item => item.status !== "succeeded").map((item, index) => <li key={index}>
          <span>{item.file.name}</span><span role={item.status === "failed" ? "alert" : "status"}>{t(item.error || (item.status === "cancelled" ? "Upload cancelled" : item.status === "uploading" ? "Uploading image…" : "Waiting to upload"))}</span>
          {(item.status === "failed" || item.status === "cancelled") && <button type="button" className="text-button" disabled={locked} onClick={() => void uploadImageBatch(imageUploads.map(candidate => candidate === item ? { ...candidate, status: "pending", error: undefined } : candidate))}>{t("Retry")} {item.file.name}</button>}
        </li>)}
      </ul>}
      {allowUrlInput && <label className="field-label asset-image-url" htmlFor={`${fieldId}-url`}>{t("Or use an image link")}<input id={`${fieldId}-url`} type="url" inputMode="url" value={imageMediaIds !== undefined || isEmbeddedImage ? "" : value} disabled={locked} placeholder="https://..." onChange={event => changeImage(event.target.value.trim())} /></label>}
      {uploadStatus}{recoveryAction}
      {uploadError && <p className="asset-image-error" role="alert">{uploadError}</p>}
      {disabled && variant !== "composer" && <p className="asset-image-help">{t("Apply or discard the AI option before changing the image.")}</p>}
    </section>;
  }

  if (variant === "composer") {
    return (
      <section className={`post-composer-media${dragActive ? " is-dragging" : ""}`} aria-label={mediaLabel} aria-busy={uploading}
        onDragOver={handleDragOver} onDragLeave={() => setDragActive(false)} onDrop={handleDrop}>
        <input ref={fileInput} type="file" className="asset-image-file-input" accept={acceptedTypes}
          aria-label={inputLabel} disabled={locked} tabIndex={-1}
          onChange={event => {
            const imageFiles = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = "";
            void uploadImages(imageFiles);
          }} />
        <button type="button" className="secondary-button post-media-add" disabled={locked} onClick={() => fileInput.current?.click()}>
          {uploading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <CloudUpload size={14} aria-hidden="true" />}
          {uploading ? busyLabel : hasMedia ? replaceLabel : t("Add media")}
        </button>
        {hasMedia && <div className="post-media-attachments">
          <div className="post-media-thumbnail">
            {videoElement || (previewFailed ? <ImageOff size={24} aria-label={t("Image preview unavailable")} />
              : <Image key={value} src={value} alt={title || t("Post image")} fill unoptimized sizes="144px" onError={() => setFailedPreviewUrl(value)} />)}
            <button type="button" className="post-media-remove" disabled={locked} aria-label={removeLabel} onClick={removeMedia}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
          <button type="button" className="post-media-replace" disabled={locked} aria-label={replaceLabel} onClick={() => fileInput.current?.click()}><ImagePlus size={22} aria-hidden="true" /></button>
        </div>}
        {uploadStatus}
        {recoveryAction}
        {uploadError && <p className="asset-image-error" role="alert">{uploadError}</p>}
        <span className="post-composer-sr-only" role="status">{!uploading && currentUpload ? t("Image added to the draft. Save changes to keep it.") : ""}</span>
      </section>
    );
  }

  return (
    <section className="drawer-section asset-image-editor" aria-labelledby={`${fieldId}-heading`}>
      <div className="asset-image-heading">
        <span id={`${fieldId}-heading`} className="field-label">{mediaLabel}</span>
        {originalImageUrl && (value !== originalImageUrl || videoMediaId) && (
          <button type="button" className="text-button asset-image-restore" disabled={locked} onClick={() => changeImage(originalImageUrl)}>
            <RotateCcw size={13} aria-hidden="true" /> {t("Restore article image")}
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        className="asset-image-file-input"
        accept={acceptedTypes}
        aria-label={inputLabel}
        disabled={locked}
        tabIndex={-1}
        onChange={(event) => {
          const imageFiles = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = "";
          void uploadImages(imageFiles);
        }}
      />

      <div
        className={`asset-image-dropzone${dragActive ? " is-dragging" : ""}${locked ? " is-locked" : ""}`}
        aria-busy={uploading}
        onDragOver={handleDragOver}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {hasMedia ? (
          <>
            <div className="asset-image-preview">
              {videoElement || (previewFailed ? (
                <div className="asset-image-unavailable"><ImageOff size={24} aria-hidden="true" /><span>{t("Image preview unavailable")}</span></div>
              ) : (
                <Image key={value} src={value} alt={title || t("Post image")} fill unoptimized sizes="(max-width: 640px) 100vw, 380px" referrerPolicy="no-referrer" onError={() => setFailedPreviewUrl(value)} />
              ))}
              {!videoUrl && <span className="asset-image-source">{sourceLabel}</span>}
            </div>
            <div className="asset-image-details">
              <div className="asset-image-copy">
                <strong title={currentUpload?.name}>{videoUrl ? t("Post video") : currentUpload?.name || sourceLabel}</strong>
                <span>{currentUpload ? `${currentUpload.width} x ${currentUpload.height} px` : t(onVideoChange ? "Drag an image or MP4 here to replace it" : "Drag an image here to replace it")}</span>
              </div>
              <div className="asset-image-actions">
                <button type="button" className="secondary-button" disabled={locked} onClick={() => fileInput.current?.click()}>
                  {uploading ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
                  {uploading ? busyLabel : replaceLabel}
                </button>
                <button type="button" className="asset-image-remove" disabled={locked} aria-label={removeLabel} title={removeLabel} onClick={removeMedia}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="asset-image-empty">
            <ImagePlus size={28} aria-hidden="true" />
            <strong>{t(onVideoChange ? "Add post media" : "Upload a post image")}</strong>
            <span>{t(onVideoChange ? "Drag an image or MP4 here, or choose a file" : "Drag an image here, or choose a file")}</span>
            <button type="button" className="secondary-button" disabled={locked} onClick={() => fileInput.current?.click()}>
              {uploading ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
              {uploading ? busyLabel : t(onVideoChange ? "Choose media" : "Choose image")}
            </button>
          </div>
        )}
      </div>

      {allowUrlInput && (
        <label className="field-label asset-image-url" htmlFor={`${fieldId}-url`}>
          {t("Or use an image link")}
          <input
            id={`${fieldId}-url`}
            type="url"
            inputMode="url"
            value={isEmbeddedImage ? "" : value}
            disabled={locked}
            placeholder={isEmbeddedImage ? t("Paste a link to replace the uploaded image") : "https://..."}
            onChange={(event) => changeImage(event.target.value.trim())}
          />
        </label>
      )}
      {uploadError && <p className="asset-image-error" role="alert">{uploadError}</p>}
      {previewFailed && allowUrlInput && <p className="asset-image-error">{t("Check the image link or upload a local file instead.")}</p>}
      {uploadStatus}
      {recoveryAction}
      {!uploading && <div className="asset-image-status" role="status">{currentUpload ? t(currentUpload.optimized ? "Image optimized and added to the draft. Save changes to keep it." : "Image added to the draft. Save changes to keep it.") : ""}</div>}
      {disabled && <p className="asset-image-help">{t("Apply or discard the AI option before changing the image.")}</p>}
    </section>
  );
}
