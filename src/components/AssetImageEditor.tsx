"use client";

import { CloudUpload, ImageOff, ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "@/lib/i18n";
import { ACCEPTED_IMAGE_TYPES, prepareUploadedImage, type PreparedImage } from "@/lib/image-upload";

interface AssetImageEditorProps {
  value: string;
  originalImageUrl?: string;
  title: string;
  disabled?: boolean;
  onChange: (imageUrl: string) => void;
  onBusyChange: (busy: boolean) => void;
}

export default function AssetImageEditor({
  value,
  originalImageUrl,
  title,
  disabled = false,
  onChange,
  onBusyChange
}: AssetImageEditorProps) {
  const t = useTranslation();
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);
  const uploadInProgress = useRef(false);
  const [uploading, setUploading] = useState(false);
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
    : value === originalImageUrl ? t("Article image") : t("Image link");

  useEffect(() => () => {
    // A closed editor or an AI candidate must never receive a late file-read result.
    uploadSequence.current += 1;
    uploadInProgress.current = false;
    onBusyChange(false);
  }, [onBusyChange]);

  async function uploadImages(imageFiles: File[]) {
    if (disabled || uploadInProgress.current || !imageFiles.length) return;
    setUploadError("");
    if (imageFiles.length !== 1) {
      setUploadError(t("Please upload one image at a time."));
      return;
    }

    const sequence = ++uploadSequence.current;
    uploadInProgress.current = true;
    setUploading(true);
    onBusyChange(true);
    try {
      const preparedImage = await prepareUploadedImage(imageFiles[0]);
      if (sequence !== uploadSequence.current) return;
      setUploadedImage(preparedImage);
      setFailedPreviewUrl("");
      onChange(preparedImage.dataUrl);
    } catch (error) {
      if (sequence !== uploadSequence.current) return;
      setUploadError(t(error instanceof Error ? error.message : "Could not process this image. Please try another file."));
    } finally {
      if (sequence === uploadSequence.current) {
        uploadInProgress.current = false;
        setUploading(false);
        onBusyChange(false);
      }
    }
  }

  function changeImage(imageUrl: string) {
    setUploadError("");
    setFailedPreviewUrl("");
    setUploadedImage(null);
    onChange(imageUrl);
  }

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

  return (
    <section className="drawer-section asset-image-editor" aria-labelledby={`${fieldId}-heading`}>
      <div className="asset-image-heading">
        <span id={`${fieldId}-heading`} className="field-label">{t("Post image")}</span>
        {originalImageUrl && value !== originalImageUrl && (
          <button type="button" className="text-button asset-image-restore" disabled={locked} onClick={() => changeImage(originalImageUrl)}>
            <RotateCcw size={13} aria-hidden="true" /> {t("Restore article image")}
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        className="asset-image-file-input"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        aria-label={t("Upload post image")}
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
        {value ? (
          <>
            <div className="asset-image-preview">
              {previewFailed ? (
                <div className="asset-image-unavailable"><ImageOff size={24} aria-hidden="true" /><span>{t("Image preview unavailable")}</span></div>
              ) : (
                <Image key={value} src={value} alt={title || t("Post image")} fill unoptimized sizes="(max-width: 640px) 100vw, 380px" referrerPolicy="no-referrer" onError={() => setFailedPreviewUrl(value)} />
              )}
              <span className="asset-image-source">{sourceLabel}</span>
            </div>
            <div className="asset-image-details">
              <div className="asset-image-copy">
                <strong title={currentUpload?.name}>{currentUpload?.name || sourceLabel}</strong>
                <span>{currentUpload ? `${currentUpload.width} x ${currentUpload.height} px` : t("Drag an image here to replace it")}</span>
              </div>
              <div className="asset-image-actions">
                <button type="button" className="secondary-button" disabled={locked} onClick={() => fileInput.current?.click()}>
                  {uploading ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
                  {t(uploading ? "Processing image…" : "Replace image")}
                </button>
                <button type="button" className="asset-image-remove" disabled={locked} aria-label={t("Remove image")} title={t("Remove image")} onClick={() => changeImage("")}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="asset-image-empty">
            <ImagePlus size={28} aria-hidden="true" />
            <strong>{t("Upload a post image")}</strong>
            <span>{t("Drag an image here, or choose a file")}</span>
            <button type="button" className="secondary-button" disabled={locked} onClick={() => fileInput.current?.click()}>
              {uploading ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
              {t(uploading ? "Processing image…" : "Choose image")}
            </button>
          </div>
        )}
      </div>

      <p id={`${fieldId}-help`} className="asset-image-help">{t("JPG, PNG or WebP, up to 5 MB. Large images are optimized automatically.")}</p>
      <label className="field-label asset-image-url" htmlFor={`${fieldId}-url`}>
        {t("Or use an image link")}
        <input
          id={`${fieldId}-url`}
          type="url"
          inputMode="url"
          value={isEmbeddedImage ? "" : value}
          disabled={locked}
          placeholder={isEmbeddedImage ? t("Paste a link to replace the uploaded image") : "https://..."}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => changeImage(event.target.value.trim())}
        />
      </label>
      {uploadError && <p className="asset-image-error" role="alert">{uploadError}</p>}
      {previewFailed && <p className="asset-image-error">{t("Check the image link or upload a local file instead.")}</p>}
      <div className="asset-image-status" role="status">
        {uploading ? t("Processing image…") : currentUpload ? t(currentUpload.optimized ? "Image optimized and added to the draft. Save changes to keep it." : "Image added to the draft. Save changes to keep it.") : ""}
      </div>
      {disabled && <p className="asset-image-help">{t("Apply or discard the AI option before changing the image.")}</p>}
    </section>
  );
}
