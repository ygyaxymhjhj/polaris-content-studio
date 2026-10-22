"use client";

import { CloudUpload, ImageOff, ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "@/lib/i18n";
import { ACCEPTED_IMAGE_TYPES, prepareUploadedImage, type PreparedImage } from "@/lib/image-upload";
import { getVideoPreviewUrl } from "@/lib/video-types";
import { uploadVideo, validateVideoUpload } from "@/lib/video-upload-client";

interface AssetImageEditorProps {
  value: string;
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

export default function AssetImageEditor({
  value,
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
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [failedPreviewUrl, setFailedPreviewUrl] = useState("");
  const [uploadedImage, setUploadedImage] = useState<PreparedImage | null>(null);
  const locked = disabled || uploading;
  const isEmbeddedImage = value.startsWith("data:image/");
  const currentUpload = uploadedImage?.dataUrl === value ? uploadedImage : null;
  const previewFailed = !!value && failedPreviewUrl === value;
  const sourceLabel = isEmbeddedImage
    ? t("Uploaded image")
    : value === originalImageUrl ? t("Article image") : urlSourceLabel ? t(urlSourceLabel) : t("Image link");
  const videoUrl = videoPreview || (videoMediaId ? getVideoPreviewUrl(videoMediaId) : "");
  const hasMedia = Boolean(value || videoUrl);
  const acceptedTypes = [...ACCEPTED_IMAGE_TYPES, ...(onVideoChange ? ["video/mp4", ".mp4"] : [])].join(",");
  const inputLabel = t(onVideoChange ? "Upload post media" : "Upload post image");
  const mediaLabel = t(onVideoChange ? "Post media" : "Post image");
  const busyLabel = videoProgress === null ? t("Processing image…") : videoProgress < 100
    ? `${t("Uploading video…")} ${videoProgress}%` : t("Video transferred. Validating and saving…");
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
    setVideoProgress(null);
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

  async function uploadImages(imageFiles: File[]) {
    if (disabled || uploadInProgress.current || !imageFiles.length) return;
    setUploadError("");
    if (imageFiles.length !== 1) {
      setUploadError(t(onVideoChange ? "Please upload one image or MP4 at a time." : "Please upload one image at a time."));
      return;
    }

    const file = imageFiles[0];
    const isVideo = Boolean(onVideoChange && !ACCEPTED_IMAGE_TYPES.includes(file.type));
    if (isVideo) {
      try { validateVideoUpload(file); }
      catch (error) { setUploadError(t((error as Error).message)); return; }
    }
    const sequence = ++uploadSequence.current;
    uploadInProgress.current = true;
    setUploading(true);
    busyCallback.current(true);
    try {
      if (isVideo) {
        const controller = new AbortController();
        uploadController.current = controller;
        setVideoProgress(0);
        localPreview.current = URL.createObjectURL(file);
        setVideoPreview(localPreview.current);
        const video = await uploadVideo(file, controller.signal, progress => {
          if (sequence === uploadSequence.current) setVideoProgress(progress);
        });
        if (sequence !== uploadSequence.current) return;
        onVideoChange?.(video.id);
        setUploadedImage(null);
      } else {
        setVideoProgress(null);
        const preparedImage = await prepareUploadedImage(file);
        if (sequence !== uploadSequence.current) return;
        setUploadedImage(preparedImage);
        setFailedPreviewUrl("");
        onChange(preparedImage.dataUrl);
      }
    } catch (error) {
      if (sequence !== uploadSequence.current) return;
      setUploadError(t(error instanceof Error ? error.message : isVideo ? "Could not upload this video. Please try again." : "Could not process this image. Please try another file."));
    } finally {
      if (sequence === uploadSequence.current) {
        uploadInProgress.current = false;
        uploadController.current = null;
        clearLocalPreview();
        setUploading(false);
        setVideoProgress(null);
        busyCallback.current(false);
      }
    }
  }

  function changeImage(imageUrl: string) {
    setUploadError("");
    setFailedPreviewUrl("");
    setUploadedImage(null);
    onChange(imageUrl);
  }

  function removeMedia() {
    setUploadError("");
    if (videoMediaId) onVideoChange?.(null);
    else changeImage("");
  }

  const videoElement = videoUrl ? <video key={videoUrl} src={videoUrl} controls preload="metadata" playsInline aria-label={t("Post video")} /> : null;
  const uploadStatus = uploading ? <div className="asset-image-status asset-video-progress" role="status">
    <span>{busyLabel}</span>
    {videoProgress !== null && <button type="button" className="text-button" onClick={cancelUpload}>{t("Cancel upload")}</button>}
  </div> : null;

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
      {!uploading && <div className="asset-image-status" role="status">{currentUpload ? t(currentUpload.optimized ? "Image optimized and added to the draft. Save changes to keep it." : "Image added to the draft. Save changes to keep it.") : ""}</div>}
      {disabled && <p className="asset-image-help">{t("Apply or discard the AI option before changing the image.")}</p>}
    </section>
  );
}
