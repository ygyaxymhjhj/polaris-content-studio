"use client";

import React, { useState } from "react";
import {
  Heart,
  MessageCircle,
  Repeat2,
  Share2,
  Bookmark,
  MoreHorizontal,
  ThumbsUp,
  MessageSquare,
  Send,
  Globe,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ImageOff
} from "lucide-react";
import type { ContentAsset } from "@/lib/types";
import { useTranslation } from "@/lib/i18n";

interface SocialPreviewProps {
  asset: ContentAsset;
  imageUrl?: string;
  authorName?: string;
  authorHandle?: string;
}

export default function SocialPreview({
  asset,
  imageUrl,
  authorName = "Polaris Insights",
  authorHandle = "polaris_insight"
}: SocialPreviewProps) {
  const currentImage = imageUrl ?? asset.imageUrl;
  const platform = asset.platform;
  const t = useTranslation();
  const [slideIndex, setSlideIndex] = useState(0);

  // Extract slides if instagram carousel
  const slides = (asset.meta?.slides as Array<{ title?: string; body?: string }>) || [];

  return (
    <div className="social-preview-wrapper" data-platform={platform}>
      <div className="preview-platform-bar">
        <span className="preview-indicator">
          <span className="preview-badge-dot" />
          {platform.toUpperCase()} {t("Real social preview")}
        </span>
        <span className="preview-char-count">{asset.content.length} {t("characters")}</span>
      </div>

      <div className="preview-card-viewport">
        {platform === "x" && (
          <div className="preview-card-x">
            <div className="mock-author-row">
              <div className="mock-avatar x-avatar">P</div>
              <div className="mock-author-meta">
                <div className="mock-name-line">
                  <span className="mock-author-name">{authorName}</span>
                  <span className="mock-author-handle">@{authorHandle}</span>
                  <span className="mock-dot">·</span>
                  <span className="mock-time">{t("Just now")}</span>
                </div>
              </div>
              <MoreHorizontal size={16} className="mock-more" />
            </div>

            <div className="mock-content-text">{asset.content}</div>

            {currentImage && (
              <div className="mock-image-container x-media">
                <img
                  src={currentImage}
                  alt={asset.title}
                  className="mock-image"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = "none";
                    const fallback = e.currentTarget.parentElement?.querySelector(".mock-image-fallback") as HTMLElement;
                    if (fallback) fallback.style.display = "flex";
                  }}
                />
                <div className="mock-image-fallback" style={{ display: "none" }}>
                  <ImageOff size={16} /> <span>{t("Image preview unavailable")}</span>
                </div>
              </div>
            )}

            <div className="mock-actions-bar x-actions">
              <div className="mock-action-item"><MessageCircle size={15} /> <span>12</span></div>
              <div className="mock-action-item"><Repeat2 size={16} /> <span>5</span></div>
              <div className="mock-action-item"><Heart size={15} /> <span>48</span></div>
              <div className="mock-action-item"><Share2 size={15} /></div>
            </div>
          </div>
        )}

        {platform === "linkedin" && (
          <div className="preview-card-linkedin">
            <div className="mock-author-row">
              <div className="mock-avatar in-avatar">P</div>
              <div className="mock-author-meta">
                <span className="mock-author-name">{authorName}</span>
                <span className="mock-author-desc">{t("Finance desk · in-depth market commentary")}</span>
                <span className="mock-time-row">{t("Just now")} · <Globe size={11} /></span>
              </div>
              <MoreHorizontal size={16} className="mock-more" />
            </div>

            <div className="mock-content-text">{asset.content}</div>

            {currentImage && (
              <div className="mock-image-container linkedin-media">
                <img
                  src={currentImage}
                  alt={asset.title}
                  className="mock-image"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = "none";
                  }}
                />
              </div>
            )}

            <div className="mock-actions-bar in-actions">
              <div className="mock-action-item"><ThumbsUp size={15} /> <span>{t("Like")}</span></div>
              <div className="mock-action-item"><MessageSquare size={15} /> <span>{t("Comment")}</span></div>
              <div className="mock-action-item"><Repeat2 size={16} /> <span>{t("Repost")}</span></div>
              <div className="mock-action-item"><Send size={14} /> <span>{t("Send")}</span></div>
            </div>
          </div>
        )}

        {platform === "facebook" && (
          <div className="preview-card-facebook">
            <div className="mock-author-row">
              <div className="mock-avatar fb-avatar">f</div>
              <div className="mock-author-meta">
                <span className="mock-author-name">{authorName}</span>
                <span className="mock-time-row">{t("Just now")} · <Globe size={11} /></span>
              </div>
              <MoreHorizontal size={16} className="mock-more" />
            </div>

            <div className="mock-content-text">{asset.content}</div>

            {currentImage && (
              <div className="mock-image-container fb-media">
                <img
                  src={currentImage}
                  alt={asset.title}
                  className="mock-image"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = "none";
                  }}
                />
                <div className="fb-domain-bar">
                  <span>POLARIS.STUDIO</span>
                  <strong>{asset.title}</strong>
                </div>
              </div>
            )}

            <div className="mock-actions-bar fb-actions">
              <div className="mock-action-item"><ThumbsUp size={16} /> <span>{t("Like")}</span></div>
              <div className="mock-action-item"><MessageCircle size={16} /> <span>{t("Comment")}</span></div>
              <div className="mock-action-item"><Share2 size={16} /> <span>{t("Share")}</span></div>
            </div>
          </div>
        )}

        {platform === "instagram" && (
          <div className="preview-card-instagram">
            <div className="mock-author-row ig-header">
              <div className="mock-avatar ig-avatar">IG</div>
              <span className="mock-author-name">{authorHandle}</span>
              <MoreHorizontal size={16} className="mock-more" />
            </div>

            <div className="mock-image-container ig-media">
              {slides.length > 0 ? (
                <div className="ig-slide-card">
                  <div className="ig-slide-head">
                    <span className="slide-badge">{t("Slides")} {slideIndex + 1} / {slides.length}</span>
                  </div>
                  <div className="ig-slide-body">
                    <h4>{slides[slideIndex]?.title || asset.title}</h4>
                    <p>{slides[slideIndex]?.body || asset.content.slice(0, 140)}</p>
                  </div>
                  <div className="slide-nav-arrows">
                    <button
                      disabled={slideIndex === 0}
                      onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      disabled={slideIndex >= slides.length - 1}
                      onClick={() => setSlideIndex((i) => Math.min(slides.length - 1, i + 1))}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              ) : currentImage ? (
                <img
                  src={currentImage}
                  alt={asset.title}
                  className="mock-image ig-square"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="mock-image-fallback">
                  <Sparkles size={20} /> <span>{t("Carousel card preview")}</span>
                </div>
              )}
            </div>

            <div className="mock-actions-bar ig-actions">
              <div className="ig-left-actions">
                <Heart size={18} />
                <MessageCircle size={18} />
                <Send size={18} />
              </div>
              <Bookmark size={18} />
            </div>

            <div className="ig-caption-block">
              <span className="ig-bold-handle">{authorHandle}</span>{" "}
              <span className="ig-caption-text">{asset.content}</span>
            </div>
          </div>
        )}

        {platform === "threads" && (
          <div className="preview-card-threads">
            <div className="threads-layout">
              <div className="threads-avatar-col">
                <div className="mock-avatar threads-avatar">@</div>
                <div className="threads-tree-line" />
              </div>
              <div className="threads-body-col">
                <div className="threads-user-row">
                  <span className="mock-author-name">{authorHandle}</span>
                  <span className="mock-time">{t("Just now")}</span>
                  <MoreHorizontal size={14} className="mock-more" />
                </div>
                <div className="mock-content-text">{asset.content}</div>

                {currentImage && (
                  <div className="mock-image-container threads-media">
                    <img
                      src={currentImage}
                      alt={asset.title}
                      className="mock-image"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = "none";
                      }}
                    />
                  </div>
                )}

                <div className="mock-actions-bar threads-actions">
                  <Heart size={16} />
                  <MessageCircle size={16} />
                  <Repeat2 size={16} />
                  <Send size={15} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
