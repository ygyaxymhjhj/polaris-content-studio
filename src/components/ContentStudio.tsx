"use client";

import {
  ArrowRight,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  CloudUpload,
  Download,
  FileText,
  Filter,
  Hash,
  History,
  Layers3,
  LayoutDashboard,
  Link2,
  Linkedin,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Video,
  Wand2,
  X,
  Zap
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LocaleContext, translate, UiLanguage, useTranslation } from "@/lib/i18n";
import JSZip from "jszip";
import fixedArticle from "@/data/test-article.json";
import { validateBrowserArticle } from "@/lib/browser-import";
import { normalizeAnalysis } from "@/lib/normalize-analysis";
import ProjectStorage from "@/components/ProjectStorage";
import type { ProjectSnapshot } from "@/lib/project-schema";
import { alignSourceConfig, ImportedSource } from "@/lib/source-config";
import {
  ContentAsset,
  DEFAULT_PLATFORMS,
  FactItem,
  MAX_REVISIONS,
  MAX_TURNS,
  PLATFORM_META,
  Platform,
  ProjectConfig,
  RewriteCandidate,
  RewriteMessage,
  RewriteRecord,
  RewriteSnapshot,
  SourceAnalysis
} from "@/lib/types";

// Frozen public article snapshot for repeatable editorial tests; never fetched on page load.
const sampleArticle = fixedArticle.text;

type View = "workspace" | "facts" | "assets" | "export" | "settings";

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "workspace", label: "Workspace", icon: LayoutDashboard },
  { id: "facts", label: "Source references", icon: ClipboardCheck },
  { id: "assets", label: "Content assets", icon: Layers3 },
  { id: "export", label: "Export center", icon: Download }
];

const platformGroups: { label: string; platforms: Platform[] }[] = [
  { label: "Web & social", platforms: ["website", "facebook", "threads", "linkedin", "x", "instagram"] },
  { label: "App & video", platforms: ["short_video", "community", "push", "kol_live", "faq"] }
];

/**
 * Channels are independent, so each one is its own request in a small pool and lands in the grid
 * the moment it arrives. Kept moderate rather than unbounded: a burst of eleven requests to one
 * provider lost four channels to network errors in testing.
 */
const PACK_CONCURRENCY = 6;

const initialConfig: ProjectConfig = {
  name: "",
  title: "",
  category: "",
  language: "en",
  audience: "",
  cta: "",
  websiteUrl: "",
  sourceUrl: "",
  tone: "Clear and professional",
  publishDate: ""
};

function platformIcon(platform: Platform) {
  const meta = PLATFORM_META[platform];
  if (platform === "facebook") return <span className="brand-letter facebook-letter">f</span>;
  if (platform === "linkedin") return <Linkedin size={16} strokeWidth={2.5} />;
  if (platform === "short_video") return <Video size={16} />;
  if (platform === "push") return <Bell size={16} />;
  if (platform === "faq") return <CircleHelp size={16} />;
  if (platform === "community") return <MessageCircle size={16} />;
  if (platform === "kol_live") return <Play size={15} fill="currentColor" />;
  return <span className="platform-glyph">{meta.icon}</span>;
}

function labelForAsset(asset: ContentAsset, t: (text: string) => string) {
  const assetType = t((asset.assetType || "content asset").replaceAll("_", " "));
  if (asset.platform === "short_video") return asset.meta?.duration ? `${assetType} · ${asset.meta.duration}` : assetType;
  if (asset.platform === "instagram") return `${assetType} · ${String(asset.meta?.slideCount || 6)} ${t("slides")}`;
  return assetType;
}

function metaValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

export default function ContentStudio() {
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("en");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("polaris-ui-language");
      if (saved === "zh" || saved === "vi" || saved === "en") setUiLanguage(saved);
      else if (navigator.language.startsWith("zh")) setUiLanguage("zh");
      else if (navigator.language.startsWith("vi")) setUiLanguage("vi");
    } catch { /* Storage may be unavailable in private browsing. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = uiLanguage === "zh" ? "zh-CN" : uiLanguage; }, [uiLanguage]);
  function changeUiLanguage(value: UiLanguage) {
    setUiLanguage(value);
    try { localStorage.setItem("polaris-ui-language", value); } catch { /* Optional preference. */ }
  }
  const t = (text: string) => translate(uiLanguage, text);
  const [view, setView] = useState<View>("workspace");
  const [config, setConfig] = useState<ProjectConfig>(() => alignSourceConfig(initialConfig, fixedArticle, new Set()));
  const editedConfig = useRef(new Set<keyof ProjectConfig>());
  const importedSource = useRef<ImportedSource | null>(fixedArticle);
  const [sourceText, setSourceText] = useState(fixedArticle.text);
  const [sourceName, setSourceName] = useState("wikifx-202609079764964517.snapshot.json");
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [browserArticle, setBrowserArticle] = useState<ImportedSource | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>(DEFAULT_PLATFORMS);
  const [selectedAsset, setSelectedAsset] = useState<ContentAsset | null>(null);
  const [deliveryDraft, setDeliveryDraft] = useState("{}");
  const [assetFilter, setAssetFilter] = useState<Platform | "all">("all");
  const [loading, setLoading] = useState<"parse" | "fetch" | "analyze" | "generate" | "export" | null>(null);
  const [toast, setToast] = useState("");
  const [usedFallback, setUsedFallback] = useState(false);
  const [generationRun, setGenerationRun] = useState("");
  const [pendingPlatforms, setPendingPlatforms] = useState<Platform[]>([]);
  const [instruction, setInstruction] = useState("");
  const [optionCount, setOptionCount] = useState(2);
  const [candidates, setCandidates] = useState<RewriteCandidate[]>([]);
  const [pendingInstruction, setPendingInstruction] = useState("");
  const [droppedTurns, setDroppedTurns] = useState(0);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // Conversations are kept per asset so reopening the drawer continues where the editor left off.
  const [threads, setThreads] = useState<Record<string, RewriteMessage[]>>({});
  const threadOnOpen = useRef<RewriteMessage[]>([]);
  const columnsAnchor = useRef<HTMLDivElement | null>(null);
  const rewriteSequence = useRef(0);
  const packSequence = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.polarisArticleImport = "v1";
    function receiveArticle(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "POLARIS_BROWSER_ARTICLE" || event.data.version !== 1) return;
      const requestId = event.data.requestId;
      if (typeof requestId !== "string" || requestId.length > 100) return;
      const article = validateBrowserArticle(event.data.article);
      const accepted = Boolean(article && !browserArticle && loading === null && !selectedAsset);
      if (accepted) setBrowserArticle(article);
      window.postMessage({ type: "POLARIS_ARTICLE_ACK", requestId, ok: accepted }, window.location.origin);
    }
    window.addEventListener("message", receiveArticle);
    return () => {
      delete document.documentElement.dataset.polarisArticleImport;
      window.removeEventListener("message", receiveArticle);
    };
  }, [browserArticle, loading, selectedAsset]);

  const activeThread = selectedAsset ? threads[selectedAsset.id] || [] : [];
  const presets = [
    ...(selectedAsset?.riskFlags.length ? ["Fix the flagged issues"] : []),
    "Try a different opening",
    "Make it more conversational",
    "Focus on one angle",
    "Strengthen the CTA",
    "Shorten it",
    "Keep every number and date"
  ];

  // A candidate is previewed by projecting it into the draft column, so the text under review is
  // read in the real editor instead of a nested scroll box.
  const previewCandidate = previewIndex !== null ? candidates[previewIndex] || null : null;
  const viewAsset = previewCandidate?.asset ?? selectedAsset;
  const viewRiskFlags = previewCandidate ? [...new Set([...previewCandidate.asset.riskFlags, ...previewCandidate.issues])] : selectedAsset?.riskFlags ?? [];

  const approvedCount = assets.filter((asset) => asset.status === "approved").length;
  const filteredAssets = useMemo(() => {
    const list = assetFilter === "all" ? assets : assets.filter((asset) => asset.platform === assetFilter);
    // Channels arrive out of order, so sort back into the canonical channel order to stop the grid
    // reshuffling while a pack is still filling in.
    return [...list].sort((a, b) => DEFAULT_PLATFORMS.indexOf(a.platform) - DEFAULT_PLATFORMS.indexOf(b.platform) || a.id.localeCompare(b.id));
  }, [assetFilter, assets]);

  function restoreProject(snapshot: ProjectSnapshot) {
    clearDerivedContent();
    importedSource.current = snapshot.importedSource;
    editedConfig.current = new Set(snapshot.editedConfig);
    setConfig(snapshot.config); setSourceText(snapshot.sourceText); setSourceName(snapshot.sourceName);
    setSourcePending(snapshot.sourcePending); setSourceError(""); setBrowserArticle(null);
    setAnalysis(snapshot.analysis); setAssets(snapshot.assets); setSelectedPlatforms(snapshot.selectedPlatforms);
    setThreads(snapshot.threads); setUsedFallback(snapshot.usedFallback); setGenerationRun(snapshot.generationRun);
    setView(snapshot.assets.length ? "assets" : "workspace");
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function updateConfig(field: keyof ProjectConfig, value: string) {
    if (field === "sourceUrl") {
      setSourcePending(value.trim() !== (importedSource.current?.sourceUrl || ""));
      setSourceError("");
      clearDerivedContent();
    }
    editedConfig.current.add(field);
    setConfig((current) => {
      const next = { ...current, [field]: value };
      return (field === "language" || field === "category") && importedSource.current
        ? alignSourceConfig(next, importedSource.current, editedConfig.current)
        : next;
    });
  }

  function clearDerivedContent() {
    packSequence.current += 1;
    rewriteSequence.current += 1;
    setRewriting(false);
    setThreads({});
    clearCandidates();
    setAnalysis(null);
    setAssets([]);
    setPendingPlatforms([]);
    setSelectedAsset(null);
    setAssetFilter("all");
    setUsedFallback(false);
    setLoading(null);
  }

  function importSource(source: ImportedSource, filename: string) {
    importedSource.current = source;
    setSourcePending(false);
    setSourceError("");
    setSourceText(source.text);
    setSourceName(filename);
    setConfig((current) => alignSourceConfig(current, source, editedConfig.current));
    clearDerivedContent();
  }

  function editSourceText(text: string) {
    const source = { text };
    importedSource.current = source;
    setSourcePending(false);
    setSourceError("");
    setSourceText(text);
    setSourceName("");
    setConfig((current) => alignSourceConfig(current, source, editedConfig.current));
    clearDerivedContent();
  }

  function downloadSource() {
    const source = importedSource.current;
    if (!source?.text) return;
    const payload = { ...source, characterCount: source.text.length, exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "polaris-article.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoading("parse");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/parse", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to parse file");
      importSource(data, file.name);
      notify("Article imported. Review the source before generating.");
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Unable to import document"));
    } finally {
      setLoading(null);
    }
  }

  function loadSample() {
    importSource(fixedArticle, "wikifx-202609079764964517.snapshot.json");
    notify("Sample article loaded.");
  }

  async function fetchArticle() {
    if (!config.sourceUrl.trim()) {
      notify("Add an article URL first.");
      return;
    }
    setLoading("fetch");
    setSourcePending(true);
    setSourceError("");
    try {
      const response = await fetch("/api/fetch-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: config.sourceUrl }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code === "SOURCE_ACCESS_DENIED" ? "The website denied server access. Paste the article or import JSON exported from your local tool. The previous article is still displayed." : data.error || "Unable to fetch article");
      importSource({ ...data, sourceUrl: data.sourceUrl || config.sourceUrl }, data.title ? `${data.title}.url` : config.sourceUrl);
      notify(`${(data.characterCount || data.text?.length || 0).toLocaleString()} ${t("characters imported")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to fetch article";
      setSourceError(message);
      notify(t(message));
    } finally {
      setLoading(null);
    }
  }

  async function runDemo() {
    const demoSource = fixedArticle;
    const demoConfig = alignSourceConfig(config, demoSource, editedConfig.current);
    importSource(demoSource, "wikifx-202609079764964517.snapshot.json");
    setLoading("analyze");
    try {
      const analysisResponse = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ article: sampleArticle, title: demoConfig.title }) });
      const rawAnalysis = await analysisResponse.json();
      if (!analysisResponse.ok) throw new Error(rawAnalysis.error || "Demo analysis failed");
      const sourceAnalysis = normalizeAnalysis(rawAnalysis, sampleArticle, demoConfig.title);
      const confirmed = { ...sourceAnalysis, facts: sourceAnalysis.facts.map((fact) => ({ ...fact, verified: fact.usableOnSocial })) };
      setAnalysis(confirmed);
      await generatePack(demoConfig, confirmed, selectedPlatforms, "Demo content pack ready to inspect.");
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Demo failed"));
    } finally {
      setLoading(null);
    }
  }

  async function analyzeArticle() {
    if (sourcePending) { notify(t("The new URL has not been imported. Fetch successfully, paste new text, or upload an article file first.")); return; }
    if (!sourceText.trim()) {
      notify("Add an article first. You can paste text or import a DOCX.");
      return;
    }
    if (loading) return;
    if (!selectedPlatforms.length) { notify(t("Select at least one channel first.")); return; }
    const run = ++packSequence.current;
    setLoading("analyze");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article: sourceText, title: config.title })
      });
      const data = await response.json();
      if (run !== packSequence.current) return;
      if (!response.ok) throw new Error(data.error || "Analysis failed");
      const mapped = normalizeAnalysis(data, sourceText, config.title);
      // The team has reviewed the article. This is source authorization, not an
      // assertion that the model's individual extractions were manually reviewed.
      // Unmatched excerpts remain excluded by normalizeAnalysis.
      const authorized: SourceAnalysis = { ...mapped, sourceReviewBasis: "team-reviewed-article", facts: mapped.facts.map(fact => ({ ...fact, verified: fact.usableOnSocial })) };
      if (!authorized.facts.some(fact => fact.verified)) throw new Error(t("No source-backed facts were extracted. Please retry; your article is preserved."));
      setAnalysis(authorized);
      await generatePack(config, authorized, selectedPlatforms, "Content pack generated and ready for review.");
    } catch (error) {
      if (run === packSequence.current) notify(error instanceof Error ? error.message : t("Analysis failed"));
    } finally {
      if (run === packSequence.current) setLoading(null);
    }
  }

  function updateFact(id: string, patch: Partial<FactItem>) {
    setAnalysis((current) => current ? { ...current, facts: current.facts.map((fact) => fact.id === id ? { ...fact, ...patch } : fact) } : current);
  }

  /**
   * Channels are independent, so each one is its own request in a small pool. The grid opens
   * straight away and fills in as results land, so the first drafts are readable in seconds instead
   * of after the slowest channel has finished.
   */
  async function generatePack(configToUse: ProjectConfig, analysisToUse: SourceAnalysis, platforms: Platform[], doneMessage: string) {
    if (!platforms.length) {
      notify("Select at least one channel first.");
      return;
    }
    const run = ++packSequence.current;
    rewriteSequence.current += 1;
    setSelectedAsset(null);
    setRewriting(false);
    setThreads({});
    clearCandidates();
    setLoading("generate");
    setGenerationRun(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    setAssets([]);
    setUsedFallback(false);
    setPendingPlatforms(platforms);
    setView("assets");
    const queue = [...platforms];
    let failed = 0;
    async function worker() {
      // `let` in a for-head gives every iteration its own binding. A while-loop variable would be
      // read back after the loop had already moved on, because React runs the updater below long
      // after this turn finished — which left the first wave stuck as "generating" forever.
      for (let channel = queue.shift(); channel; channel = queue.shift()) {
        if (run !== packSequence.current) return;
        try {
          const response = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: configToUse, analysis: analysisToUse, platforms: [channel] })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Generation failed");
          if (run !== packSequence.current) return;
          setAssets((current) => [...current, ...(data.assets || [])]);
          setUsedFallback((current) => current || Boolean(data.usedFallback));
        } catch {
          failed += 1;
        } finally {
          if (run === packSequence.current) setPendingPlatforms((current) => current.filter((item) => item !== channel));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PACK_CONCURRENCY, queue.length) }, worker));
    if (run !== packSequence.current) return;
    setLoading(null);
    notify(failed ? `${failed} ${t("channels could not be generated.")}` : doneMessage);
  }

  function generateContent(analysisToUse: SourceAnalysis = analysis as SourceAnalysis) {
    if (sourcePending) { notify(t("The new URL has not been imported. Fetch successfully, paste new text, or upload an article file first.")); return; }
    if (!analysisToUse) return;
    return generatePack(config, analysisToUse, selectedPlatforms, "Content pack generated and ready for review.");
  }

  async function approveFactsAndGenerate() {
    if (!analysis) return;
    if (!analysis.facts.some(fact => fact.verified && fact.usableOnSocial)) {
      notify(t("Select and confirm at least one usable fact first."));
      return;
    }
    await generateContent(analysis);
  }

  function clearCandidates() {
    setCandidates([]);
    setPreviewIndex(null);
    setRewriteError("");
  }

  /** Discarding is a decision too: the rejected summaries become context the next request sees. */
  function discardCandidates() {
    if (selectedAsset && candidates.length) {
      const rejected = candidates.map((candidate, index) => `Option ${index + 1}: ${candidate.changeSummary}`).join(" | ");
      setThreads((current) => ({
        ...current,
        [selectedAsset.id]: [
          ...(current[selectedAsset.id] || []),
          { role: "assistant" as const, text: `(not applied) ${rejected}`, at: new Date().toISOString(), adopted: false }
        ].slice(-MAX_TURNS)
      }));
    }
    clearCandidates();
  }

  function openAsset(asset: ContentAsset) {
    rewriteSequence.current += 1;
    setRewriting(false);
    setSelectedAsset(asset);
    setDeliveryDraft(JSON.stringify(asset.meta || {}, null, 2));
    setInstruction("");
    clearCandidates();
    setDroppedTurns(0);
    setPendingInstruction("");
    threadOnOpen.current = threads[asset.id] ? [...threads[asset.id]] : [];
  }

  // Closing without saving rolls the conversation back too: the thread must never claim a change
  // the draft did not keep.
  const closeDrawer = useCallback(() => {
    rewriteSequence.current += 1;
    setRewriting(false);
    const id = selectedAsset?.id;
    setSelectedAsset(null);
    clearCandidates();
    setInstruction("");
    if (!id) return;
    setThreads((current) => {
      const next = { ...current };
      if (threadOnOpen.current.length) next[id] = threadOnOpen.current;
      else delete next[id];
      return next;
    });
  }, [selectedAsset]);

  useEffect(() => {
    if (!selectedAsset) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeDrawer();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedAsset, closeDrawer]);

  // The answer lands in the draft column, so bring the columns into view rather than the option
  // cards at the bottom of a possibly long thread.
  useEffect(() => {
    if (candidates.length) columnsAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [candidates]);

  async function requestRewrite() {
    if (!selectedAsset || !analysis) return;
    const text = instruction.trim();
    if (!text) { notify("Type what you want changed."); return; }
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(deliveryDraft);
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid notes");
    } catch { notify(t("Delivery notes must be a valid JSON object.")); return; }
    const draft = { ...selectedAsset, meta };
    setSelectedAsset(draft);
    const run = ++rewriteSequence.current;
    setRewriting(true);
    // Options left over from the previous round were never adopted, so they become negative
    // context for this request: the model sees which directions were already tried and rejected.
    const rejected = candidates.map((candidate, index) => `Option ${index + 1}: ${candidate.changeSummary}`).join(" | ");
    const baseThread: RewriteMessage[] = rejected
      ? [...activeThread, { role: "assistant" as const, text: `(not applied) ${rejected}`, at: new Date().toISOString(), adopted: false }].slice(-MAX_TURNS)
      : activeThread;
    if (rejected) setThreads((current) => ({ ...current, [selectedAsset.id]: baseThread }));
    setRewriteError("");
    setCandidates([]);
    setPreviewIndex(null);
    try {
      const response = await fetch("/api/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, analysis, asset: draft, turns: baseThread, instruction: text, count: optionCount })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Rewrite failed");
      if (run !== rewriteSequence.current) return;
      // The instruction joins the thread as soon as the model answers it, so the next request
      // inherits this round even when none of its options gets adopted.
      setThreads((current) => ({
        ...current,
        [selectedAsset.id]: [...(current[selectedAsset.id] || []), { role: "user" as const, text, at: new Date().toISOString() }].slice(-MAX_TURNS)
      }));
      setCandidates(data.candidates || []);
      // Open on the first option so the revision is visible in the draft column right away.
      setPreviewIndex(data.candidates?.length ? 0 : null);
      setDroppedTurns(Number(data.droppedTurns) || 0);
      setPendingInstruction(text);
    } catch (error) {
      if (run !== rewriteSequence.current) return;
      // Surface the failure in the panel, not only in a toast that can be missed.
      const message = error instanceof Error ? error.message : t("Rewrite failed");
      setRewriteError(message);
      notify(message);
    } finally {
      if (run === rewriteSequence.current) setRewriting(false);
    }
  }

  function adoptCandidate(candidate: RewriteCandidate) {
    if (!selectedAsset) return;
    const at = new Date().toISOString();
    const record: RewriteRecord = {
      at,
      instruction: pendingInstruction || candidate.changeSummary,
      before: { title: selectedAsset.title, content: selectedAsset.content, cta: selectedAsset.cta, meta: selectedAsset.meta, factIds: selectedAsset.factIds }
    };
    // Delivery notes merge rather than replace, so a revision that returns no meta keeps the brief.
    const meta = { ...selectedAsset.meta, ...candidate.asset.meta };
    setSelectedAsset({
      ...selectedAsset,
      title: candidate.asset.title,
      content: candidate.asset.content,
      cta: candidate.asset.cta,
      meta,
      factIds: candidate.asset.factIds,
      riskFlags: [...new Set([...candidate.asset.riskFlags, ...candidate.issues])],
      status: "needs_review",
      updatedAt: at,
      revisions: [...(selectedAsset.revisions || []), record].slice(-MAX_REVISIONS)
    });
    setDeliveryDraft(JSON.stringify(meta, null, 2));
    // The instruction turn was already recorded when the options came back; adopting only adds
    // the applied outcome so the thread shows what happened without duplicating the request.
    setThreads((current) => ({
      ...current,
      [selectedAsset.id]: [
        ...(current[selectedAsset.id] || []),
        { role: "assistant" as const, text: `(applied) ${candidate.changeSummary}`, at, adopted: true }
      ].slice(-MAX_TURNS)
    }));
    clearCandidates();
    notify("Option applied. Review it, then save the asset.");
  }

  function revertRevision(index: number) {
    if (!selectedAsset?.revisions) return;
    const snapshot: RewriteSnapshot = selectedAsset.revisions[index].before;
    const meta = snapshot.meta || {};
    setSelectedAsset({
      ...selectedAsset,
      title: snapshot.title,
      content: snapshot.content,
      cta: snapshot.cta,
      meta,
      factIds: snapshot.factIds,
      status: "needs_review",
      updatedAt: new Date().toISOString(),
      revisions: selectedAsset.revisions.slice(0, index)
    });
    setDeliveryDraft(JSON.stringify(meta, null, 2));
    notify("Reverted to the state before that revision.");
  }

  function saveAsset() {
    if (!selectedAsset) return;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(deliveryDraft);
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid notes");
    } catch { notify(t("Delivery notes must be a valid JSON object.")); return; }
    rewriteSequence.current += 1;
    setRewriting(false);
    const draft = selectedAsset;
    // Merge the drawer's fields onto whatever the asset looks like now: a pack regenerated while
    // the editor was open must not be clobbered by a stale copy.
    setAssets((current) => current.map((asset) => asset.id === draft.id ? {
      ...asset,
      title: draft.title,
      content: draft.content,
      cta: draft.cta,
      deepLink: draft.deepLink,
      factIds: draft.factIds,
      riskFlags: draft.riskFlags,
      revisions: draft.revisions,
      meta,
      status: "needs_review",
      updatedAt: new Date().toISOString()
    } : asset));
    setSelectedAsset(null);
    clearCandidates();
    notify("Asset changes saved.");
  }

  function updateSelectedAsset(field: keyof ContentAsset, value: string) {
    setSelectedAsset((asset) => asset ? { ...asset, [field]: value } : asset);
  }

  function approveAsset(id: string) {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, status: "approved" } : asset));
    if (selectedAsset?.id === id) setSelectedAsset((asset) => asset ? { ...asset, status: "approved" } : asset);
    notify("Asset approved.");
  }

  function togglePlatform(platform: Platform) {
    setSelectedPlatforms((current) => current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform]);
  }

  async function exportPackage() {
    if (!assets.length) {
      notify("Generate content before exporting.");
      return;
    }
    if (assets.some(asset => asset.status !== "approved")) {
      notify(t("Approve every asset before export."));
      return;
    }
    setLoading("export");
    const zip = new JSZip();
    zip.file("project.json", JSON.stringify({ config, exportedAt: new Date().toISOString() }, null, 2));
    zip.file("source/fact-pack.json", JSON.stringify(analysis, null, 2));
    assets.forEach((asset) => {
      const folder = asset.platform.replace("_", "-");
      zip.file(`${folder}/${asset.id}.md`, `# ${asset.title}\n\n${asset.content}\n\nCTA: ${asset.cta || "—"}\nFact IDs: ${asset.factIds.join(", ")}\n\n## ${t("Delivery notes")}\n\n${Object.entries(asset.meta || {}).map(([key, value]) => `### ${key}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`).join("\n\n")}`);
      zip.file(`${folder}/${asset.id}.json`, JSON.stringify(asset, null, 2));
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "content-pack"}.zip`;
    link.click();
    URL.revokeObjectURL(url);
    setLoading(null);
    notify("Content pack exported.");
  }

  function goTo(viewName: View) {
    if (viewName === "facts" && !analysis) {
      notify("Analyze an article first.");
      return;
    }
    if (viewName === "assets" && !assets.length) {
      notify("Generate content first.");
      return;
    }
    setView(viewName);
  }

  return (
    <LocaleContext.Provider value={uiLanguage}><div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>✦</span></div>
          <div>
            <div className="brand-name">POLARIS</div>
            <div className="brand-product">Content Studio</div>
          </div>
        </div>

        <div className="workspace-label">{t("WORKSPACE")}</div>
        <button className="workspace-switcher">
          <span className="workspace-avatar">W</span>
          <span className="workspace-copy"><strong>WikiGlobal</strong><small>{t("Growth team")}</small></span>
          <ChevronDown size={15} />
        </button>

        <nav className="main-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => goTo(id)}>
              <Icon size={17} strokeWidth={view === id ? 2.3 : 1.8} />
              <span>{t(label)}</span>
              {id === "facts" && analysis && <span className="nav-count">{analysis.facts.length}</span>}
              {id === "assets" && assets.length > 0 && <span className="nav-count">{assets.length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-project">
          <div className="sidebar-section-title"><span>{t("RECENT PROJECT")}</span><button onClick={() => setView("workspace")}><Plus size={14} /></button></div>
          <button className={`project-mini ${view === "workspace" || view === "facts" || view === "assets" ? t("selected") : ""}`} onClick={() => setView(analysis ? "assets" : "workspace")}>
            <span className="project-mini-icon"><Zap size={15} fill="currentColor" /></span>
            <span><strong>{config.name || t("New project")}</strong><small>{analysis ? t("In progress") : t("New project")}</small></span>
            <MoreHorizontal size={16} />
          </button>
        </div>

        <div className="sidebar-bottom">
          <button className={`nav-item ${view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}><Settings2 size={17} /><span>{t("Settings")}</span></button>
          <div className="user-row"><div className="user-avatar">AL</div><div><strong>Alex Lee</strong><small>{t("Content operator")}</small></div><MoreHorizontal size={16} /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Growth OS</span><span className="slash">/</span><strong>{config.name || t("New project")}</strong></div>
          <div className="topbar-actions">
            <label className="locale-switcher"><span>{t("Interface language")}</span><select aria-label={t("Interface language")} value={uiLanguage} onChange={(event) => changeUiLanguage(event.target.value as UiLanguage)}><option value="en">{t("English")}</option><option value="zh">简体中文</option><option value="vi">Tiếng Việt</option></select></label>
            <div className="system-status"><span className="status-dot" /> {t("All systems operational")}</div>
            <button className="icon-button"><Search size={17} /></button>
            <button className="icon-button"><Bell size={17} /></button>
            <button className="help-button"><CircleHelp size={16} /> {t("Help")}</button>
          </div>
        </header>

        <div className="content-wrap">
          <ProjectStorage snapshot={{ schemaVersion: 1, config, sourceText, sourceName, sourcePending, importedSource: importedSource.current, editedConfig: [...editedConfig.current], analysis, assets, selectedPlatforms, threads, usedFallback, generationRun }} busy={loading !== null || rewriting || selectedAsset !== null} onRestore={restoreProject} />
          {view === "workspace" && <>
            {(sourceError || sourcePending) && <div className="info-banner" role="alert"><TriangleAlert size={18} /><div>{t(sourceError || "The new URL has not been imported. Fetch successfully, paste new text, or upload an article file first.")}<p>{t("Currently loaded source")}: {importedSource.current?.sourceUrl || sourceName || "—"}</p></div></div>}
            <a className="secondary-button" href="/downloads/polaris-article-import.zip" download><Download size={15} /> {t("Download browser extension")}</a>
            <p className="config-source-note">{t("Install once, open the article in your own browser, preview and send it here. No server fetch required.")}</p>
            <button className="secondary-button" onClick={downloadSource} disabled={!sourceText.trim() || sourcePending}><Download size={15} /> {t("Export article JSON")}</button>
            <p className="config-source-note">{t("Export after a successful local fetch, then upload this JSON on the deployed site. This exports the source article, not generated assets.")}</p>
          </>}
          {view === "workspace" && (
            <WorkspaceView
              config={config}
              updateConfig={updateConfig}
              sourceText={sourceText}
              setSourceText={editSourceText}
              sourceName={sourceName}
              loading={loading}
              selectedPlatforms={selectedPlatforms}
              togglePlatform={togglePlatform}
              handleFile={handleFile}
              loadSample={loadSample}
              analyzeArticle={analyzeArticle}
              hasAnalysis={Boolean(analysis)}
              goTo={goTo}
              runDemo={runDemo}
              fetchArticle={fetchArticle}
            />
          )}
          {view === "facts" && analysis && (
            <FactsView analysis={analysis} sourceText={sourceText} updateFact={updateFact} onGenerate={approveFactsAndGenerate} loading={loading} />
          )}
          {view === "assets" && (
            <AssetsView assets={assets} filteredAssets={filteredAssets} filter={assetFilter} setFilter={setAssetFilter} onOpen={openAsset} onApprove={approveAsset} onGenerate={() => analysis && generateContent()} onExport={() => setView("export")} loading={loading} usedFallback={usedFallback} pendingPlatforms={pendingPlatforms} targetCount={selectedPlatforms.length} />
          )}
          {view === "export" && <ExportView assets={assets} approvedCount={approvedCount} onExport={exportPackage} loading={loading} />}
          {view === "settings" && <SettingsView />}
        </div>
      </main>

      {browserArticle && <div className="drawer-backdrop">
        <aside className="asset-drawer" role="dialog" aria-modal="true" aria-label={t("Article from your browser")}>
          <h2>{t("Article from your browser")}</h2>
          <p>{t("Confirm to replace the current source and clear its facts and assets. Nothing changes until you confirm.")}</p>
          <h3>{browserArticle.title}</h3>
          <p style={{ overflowWrap: "anywhere" }}>{browserArticle.sourceUrl}</p>
          <p>{browserArticle.text.length.toLocaleString()} {t("characters")}</p>
          <textarea aria-label={t("Article preview")} className="drawer-textarea" style={{ width: "100%" }} readOnly value={browserArticle.text} />
          <div className="drawer-footer">
            <button className="secondary-button" onClick={() => setBrowserArticle(null)}>{t("Cancel")}</button>
            <button className="primary-button" disabled={loading !== null} onClick={() => { importSource(browserArticle, "browser-import.json"); setBrowserArticle(null); setView("workspace"); notify(t("Article imported. Review the source before generating.")); }}>{t("Confirm article import")}</button>
          </div>
        </aside>
      </div>}

      {selectedAsset && viewAsset && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
          <aside className="asset-drawer">
            <div className="drawer-header">
              <div><span className="eyebrow">{t("EDIT ASSET")}</span><h2>{t(PLATFORM_META[selectedAsset.platform].label)}</h2></div>
              <button className="icon-button" aria-label={t("Close editor")} onClick={closeDrawer}><X size={18} /></button>
            </div>
            <div className="drawer-meta"><span className="platform-chip" style={{ "--chip-accent": PLATFORM_META[selectedAsset.platform].accent } as React.CSSProperties}>{platformIcon(selectedAsset.platform)} {labelForAsset(selectedAsset, t)}</span><span className={`status-badge ${selectedAsset.status}`}>{t(selectedAsset.status.replace("_", " "))}</span></div>

            <div className="drawer-columns" ref={columnsAnchor}>
              <div className="drawer-col">
                <div className="col-head">
                  {candidates.length
                    ? <div className="preview-tabs"><button className={previewIndex === null ? "active" : ""} onClick={() => setPreviewIndex(null)}>{t("Draft")}</button>{candidates.map((_, index) => <button key={index} className={previewIndex === index ? "active" : ""} onClick={() => setPreviewIndex(index)}>{t("Option")} {index + 1}</button>)}</div>
                    : <span className="eyebrow">{t("Draft")}</span>}
                  <span className="col-hint">{viewAsset.content.length.toLocaleString()} {t("characters")}</span>
                </div>
                {previewCandidate && <div className="preview-banner">
                  <strong>{t("Preview (not saved)")}</strong>
                  <p>{previewCandidate.changeSummary}</p>
                  <div className="preview-banner-actions"><button className="text-button" onClick={discardCandidates}>{t("Discard")}</button><button className="small-button" onClick={() => adoptCandidate(previewCandidate)}><Check size={14} /> {t("Use this option")}</button></div>
                </div>}
                <label className="field-label">{t("Title / internal name")}<input value={viewAsset.title} disabled={!!previewCandidate} onChange={(event) => updateSelectedAsset("title", event.target.value)} /></label>
                <label className="field-label">{t("Content")}<textarea className="drawer-textarea" value={viewAsset.content} disabled={!!previewCandidate} onChange={(event) => updateSelectedAsset("content", event.target.value)} /></label>
                <label className="field-label">{t("CTA")}<input value={viewAsset.cta || ""} disabled={!!previewCandidate} onChange={(event) => updateSelectedAsset("cta", event.target.value)} /></label>
                {viewAsset.deepLink !== undefined && <label className="field-label">{t("Deep link")}<input value={viewAsset.deepLink || ""} disabled={!!previewCandidate} onChange={(event) => updateSelectedAsset("deepLink", event.target.value)} /></label>}
                <div className="drawer-section"><div className="field-label">{t("Source references")}</div><div className="reference-list">{viewAsset.factIds.length ? viewAsset.factIds.map((id) => <span key={id} className="fact-reference"><ShieldCheck size={13} /> {id}</span>) : <span className="muted">{t("No references attached")}</span>}</div></div>
                {viewAsset.meta && <div className="drawer-section"><div className="field-label">{t("Delivery notes")}</div><div className="delivery-notes">{Object.entries(viewAsset.meta).map(([key, value]) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><strong>{metaValue(value)}</strong></div>)}</div></div>}
                <label className="field-label">{t("Edit delivery notes (JSON)")}<textarea className="drawer-textarea" value={previewCandidate ? JSON.stringify({ ...selectedAsset.meta, ...previewCandidate.asset.meta }, null, 2) : deliveryDraft} disabled={!!previewCandidate} onChange={event => setDeliveryDraft(event.target.value)} /></label>
                {!!viewRiskFlags.length && <div className="info-banner"><div><strong>{t("Review before publishing")}</strong><ul>{viewRiskFlags.map((flag, index) => <li key={index}>{flag}</li>)}</ul></div></div>}
              </div>

              <div className="drawer-col rewrite-col">
                <div className="col-head"><span className="eyebrow">{t("AI REWRITE")}</span><span className="col-hint">{t("Grounded in confirmed facts")}</span></div>

                {!!rewriteError && <div className="rewrite-error"><TriangleAlert size={15} /><div><strong>{t("The rewrite did not run")}</strong><p>{rewriteError}</p><button className="text-button" onClick={requestRewrite}>{t("Try again")}</button></div></div>}

                {!!activeThread.length && <div className="rewrite-thread">{activeThread.map((turn, index) => <div className={`thread-turn ${turn.role}`} key={`${turn.at}-${index}`}><span className="thread-role">{turn.role === "user" ? t("You") : "AI"}</span><p>{turn.text}</p></div>)}</div>}
                {rewriting
                  ? <div className="thread-thinking"><Loader2 className="spin" size={14} /> {t("Revising…")}</div>
                  : !activeThread.length && !candidates.length && <div className="thread-empty"><strong>{t("Ask for a specific change.")}</strong>{t("The AI edits the draft in place and keeps every other sentence as it stands. Only confirmed facts can be used.")}</div>}

                <div className="preset-row">{presets.map((preset) => <button key={preset} className="preset-chip" onClick={() => setInstruction(t(preset))}>{t(preset)}</button>)}</div>
                <label className="field-label">{t("What should change?")}<textarea className="rewrite-input" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t("e.g. Cut the first sentence and keep every number and date.")} /></label>
                <div className="composer-actions">
                  <label className="option-count">{t("Options")}<select aria-label={t("Options")} value={optionCount} onChange={(event) => setOptionCount(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
                  <button className="primary-button" onClick={requestRewrite} disabled={rewriting || !instruction.trim()}>{rewriting ? <><Loader2 className="spin" size={15} /> {t("Revising…")}</> : <><Wand2 size={15} /> {t("Generate options")}</>}</button>
                </div>
                {droppedTurns > 0 && <div className="thread-note"><History size={12} /> {t("Older turns were dropped to fit the model's context window.")}</div>}

                {!!candidates.length && <div className="candidate-section">
                  <div className="col-head"><span className="eyebrow">{t("OPTIONS TO REVIEW")}</span><button className="text-button" onClick={discardCandidates}>{t("Discard")}</button></div>
                  {candidates.map((candidate, index) => {
                    const delta = candidate.asset.content.length - selectedAsset.content.length;
                    return <div className={`candidate-card ${previewIndex === index ? "active" : ""}`} key={`${candidate.asset.id}-${index}`}>
                      <span className="candidate-label">{t("Option")} {index + 1}</span>
                      <p className="candidate-summary">{candidate.changeSummary}</p>
                      <div className="candidate-metrics">
                        <span className="metric-chip">{candidate.asset.content.length.toLocaleString()} {t("characters")}{delta !== 0 && ` (${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString()})`}</span>
                        <span className={`metric-chip ${candidate.issues.length ? "warn" : "ok"}`}>{candidate.issues.length ? `${candidate.issues.length} ${t("quality issues")}` : t("No quality issues")}</span>
                        <span className="metric-chip">{candidate.asset.factIds.length} {t("source refs")}</span>
                      </div>
                      {!!candidate.issues.length && <div className="candidate-issues"><strong><TriangleAlert size={12} /> {t("Still needs a look")}</strong><ul>{candidate.issues.map((issue, issueIndex) => <li key={issueIndex}>{issue}</li>)}</ul></div>}
                      <div className="candidate-actions"><button className="preview-button" onClick={() => setPreviewIndex(index)}>{t("Preview")}</button><button className="small-button" onClick={() => adoptCandidate(candidate)}><Check size={14} /> {t("Use this option")}</button></div>
                    </div>;
                  })}
                </div>}

                {!!selectedAsset.revisions?.length && <div className="revision-section">
                  <div className="col-head"><span className="eyebrow">{t("REVISION HISTORY")}</span><span className="col-hint">{selectedAsset.revisions.length} / {MAX_REVISIONS}</span></div>
                  {selectedAsset.revisions.map((record, index) => <div className="revision-row" key={`${record.at}-${index}`}>
                    <span className="revision-index">{index + 1}</span>
                    <span className="revision-copy"><strong>{record.instruction}</strong><small>{new Date(record.at).toLocaleString()}</small></span>
                    <button className="revert-button" onClick={() => revertRevision(index)}><RotateCcw size={12} /> {t("Undo")}</button>
                  </div>)}
                </div>}
              </div>
            </div>

            <div className="drawer-footer"><button className="secondary-button" onClick={closeDrawer}>{t("Cancel")}</button><button className="primary-button" onClick={saveAsset}><Check size={16} /> {t("Save changes")}</button></div>
          </aside>
        </div>
      )}

      {toast && <div className="toast"><CheckCircle2 size={17} /> {t(toast)}</div>}
    </div></LocaleContext.Provider>
  );
}

function WorkspaceView({
  config, updateConfig, sourceText, setSourceText, sourceName, loading, selectedPlatforms, togglePlatform, handleFile, loadSample, analyzeArticle, hasAnalysis, goTo, runDemo, fetchArticle
}: {
  config: ProjectConfig;
  updateConfig: (field: keyof ProjectConfig, value: string) => void;
  sourceText: string;
  setSourceText: (value: string) => void;
  sourceName: string;
  loading: string | null;
  selectedPlatforms: Platform[];
  togglePlatform: (platform: Platform) => void;
  handleFile: (event: ChangeEvent<HTMLInputElement>) => void;
  loadSample: () => void;
  analyzeArticle: () => void;
  hasAnalysis: boolean;
  goTo: (view: View) => void;
  runDemo: () => void;
  fetchArticle: () => void;
}) {
  const t = useTranslation();
  return (
    <>
      <div className="page-heading hero-heading">
        <div><div className="eyebrow">{t("CONTENT GROWTH WORKSPACE")} <span className="live-pill">V1</span></div><h1>{t("Turn one article into")}<br /><em>{t("a week of growth.")}</em></h1><p>{t("Start with a verified source. Polaris adapts it into platform-ready content without losing the facts.")}</p></div>
        <div className="hero-orbit"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-core">✦</div><span className="orbit-label orbit-label-one">SEO</span><span className="orbit-label orbit-label-two">SOCIAL</span><span className="orbit-label orbit-label-three">APP</span></div>
      </div>

      <div className="metric-row">
        <div className="metric-card"><div className="metric-icon amber"><FileText size={17} /></div><div><strong>1</strong><span>{t("source article")}</span></div></div>
        <div className="metric-card"><div className="metric-icon blue"><Layers3 size={17} /></div><div><strong>8–12</strong><span>{t("content assets")}</span></div></div>
        <div className="metric-card"><div className="metric-icon green"><ShieldCheck size={17} /></div><div><strong>100%</strong><span>{t("source-backed")}</span></div></div>
        <div className="metric-card"><div className="metric-icon purple"><BarChart3 size={17} /></div><div><strong>1</strong><span>{t("review gate")}</span></div></div>
      </div>

      <div className="info-banner">{t("Test mode: the saved WikiFX article is preloaded on page load. No fetch needed; review facts before generating. You can still replace the source.")}</div>
      <section className="panel source-panel">
        <div className="section-heading"><div><span className="step-number">01</span><div className="heading-copy"><h2>{t("Bring in your source")}</h2><p>{t("This article remains the single source of truth for every output.")}</p></div></div><div className="heading-links"><button className="text-button" onClick={loadSample}><Sparkles size={15} /> {t("Restore test article")}</button><button className="text-button demo-link" onClick={runDemo} disabled={loading !== null}><Play size={14} fill="currentColor" /> {t("Preview full demo")}</button></div></div>
        <div className="url-import">
          <div className="url-import-icon"><Link2 size={17} /></div>
          <div className="url-import-body"><div className="url-import-label"><strong>{t("Fetch from an article URL")}</strong><span>{t("Best for public HTML pages")}</span></div><div className="url-input-row"><input value={config.sourceUrl} onChange={(event) => updateConfig("sourceUrl", event.target.value)} placeholder="https://example.com/your-article" /><button className="secondary-button" onClick={fetchArticle} disabled={loading === "fetch"}>{loading === "fetch" ? <><Loader2 className="spin" size={15} /> {t("Fetching…")}</> : <><Link2 size={15} /> {t("Fetch article")}</>}</button></div></div>
        </div>
        <div className="source-grid">
          <div className="dropzone-wrap">
            <label className={`dropzone ${sourceName ? "has-file" : ""}`}>
              <input type="file" accept=".docx,.json" onChange={handleFile} />
              <div className="upload-icon">{loading === "parse" ? <Loader2 className="spin" size={22} /> : sourceName ? <Check size={22} /> : <CloudUpload size={22} />}</div>
              <strong>{sourceName || "Drop a DOCX here, or browse"}</strong>
              <span>{sourceName ? `${sourceText.length.toLocaleString()} ${t("characters imported")}` : t("DOCX or crawler JSON · up to 8 MB")}</span>
              {!sourceName && <span className="browse-link">{t("Choose file")} <ArrowRight size={13} /></span>}
            </label>
            <div className="or-divider"><span>{t("or paste article text")}</span></div>
            <textarea className="source-textarea" placeholder={t("Paste the full article here…")} value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
            <div className="textarea-footer"><span>{sourceText.length.toLocaleString()} {t("characters")}</span><span>{t("Source only · no unsupported claims")}</span></div>
          </div>
          <div className="config-column">
            <p className="config-source-note">{t("Article imports update automatic fields. Topic and audience are suggestions to review; manually edited fields are kept.")}</p>
            <div className="input-grid">
              <label className="field-label">{t("Project name")}<input value={config.name} onChange={(event) => updateConfig("name", event.target.value)} placeholder={t("e.g. Gold regulation launch")} /></label>
              <label className="field-label">{t("Article title")}<input value={config.title} onChange={(event) => updateConfig("title", event.target.value)} placeholder={t("Working headline")} /></label>
              <label className="field-label">{t("Category")}<select aria-label={t("Category")} value={config.category} onChange={(event) => updateConfig("category", event.target.value)}><option value="">{t("Select category")}</option><option value="Market news">{t("Market news")}</option><option value="Commodities">{t("Commodities")}</option><option value="Gold">{t("Gold")}</option><option value="Forex">{t("Forex")}</option><option value="Broker">{t("Broker")}</option><option value="Scam alert">{t("Scam alert")}</option><option value="KOL LIVE">{t("KOL LIVE")}</option><option value="Point Mall">{t("Point Mall")}</option></select></label>
              <label className="field-label">{t("Language")}<select aria-label={t("Language")} value={config.language} onChange={(event) => updateConfig("language", event.target.value as ProjectConfig["language"])}><option value="en">{t("English")}</option><option value="vi">{t("Vietnamese")}</option><option value="zh">{t("Chinese")}</option></select><span className="optional">{t("LinkedIn is always English")}</span></label>
              <label className="field-label full-field">{t("Target audience")}<input value={config.audience} onChange={(event) => updateConfig("audience", event.target.value)} placeholder={t("Who should care about this?")} /></label>
              <label className="field-label full-field">{t("Primary CTA")}<input value={config.cta} onChange={(event) => updateConfig("cta", event.target.value)} placeholder={t("Read the full breakdown")} /></label>
              <label className="field-label full-field">{t("Website URL")} <span className="optional">{t("optional")}</span><input value={config.websiteUrl} onChange={(event) => updateConfig("websiteUrl", event.target.value)} placeholder={t("Add after the article goes live")} /></label>
            </div>
          </div>
        </div>
      </section>

      <section className="panel distribution-panel">
        <div className="section-heading"><div><span className="step-number">02</span><div className="heading-copy"><h2>{t("Choose your distribution pack")}</h2><p>{t("Each channel gets its own angle, format and call to action.")}</p></div></div><span className="selection-count">{selectedPlatforms.length} / {DEFAULT_PLATFORMS.length} {t("selected")}</span></div>
        <div className="platform-selection">
          {platformGroups.map((group) => <div className="platform-group" key={group.label}><div className="platform-group-label">{t(group.label)}</div><div className="platform-options">{group.platforms.map((platform) => { const meta = PLATFORM_META[platform]; const selected = selectedPlatforms.includes(platform); return <button key={platform} className={`platform-option ${selected ? t("selected") : ""}`} onClick={() => togglePlatform(platform)}><span className="platform-icon" style={{ "--platform-accent": meta.accent } as React.CSSProperties}>{platformIcon(platform)}</span><span>{t(meta.label)}</span>{selected && <Check size={14} className="option-check" />}</button>; })}</div></div>)}
        </div>
        <div className="panel-actions"><span className="action-note"><ShieldCheck size={15} /> {t("Your source is already reviewed. Review generated drafts before export.")}</span><button className="primary-button large" onClick={analyzeArticle} disabled={loading !== null}>{loading === "analyze" ? <><Loader2 className="spin" size={17} /> {t("Preparing source references…")}</> : <><Sparkles size={17} /> {t("Generate social drafts")} <ArrowRight size={16} /></>}</button></div>
        {hasAnalysis && <button className="existing-analysis" onClick={() => goTo("facts")}>{t("View source references (optional)")} <ArrowRight size={14} /></button>}
      </section>
    </>
  );
}

function FactsView({ analysis, sourceText, updateFact, onGenerate, loading }: { analysis: SourceAnalysis; sourceText: string; updateFact: (id: string, patch: Partial<FactItem>) => void; onGenerate: () => void; loading: string | null }) {
  const t = useTranslation();
  const [scope, setScope] = useState("all");
  const [limit, setLimit] = useState(10);
  const rank = { high: 0, medium: 1, low: 2 };
  const filtered = analysis.facts.filter(fact => scope === "all" || (scope === "pending" ? !fact.verified : fact.riskLevel === "high"));
  const ordered = [...filtered].sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel]);
  const displayed = ordered.slice(0, limit);
  const usableConfirmed = analysis.facts.filter(fact => fact.verified && fact.usableOnSocial).length;

  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <div className="eyebrow">{t("STEP 01 / SOURCE CONTROL")}</div>
          <h1>{t("Source references")}</h1>
          <p>{t("Extracted from your team's reviewed article. These are optional reference controls, not a second mandatory fact review. Check the generated copy against the source before approving it.")}</p>
        </div>
        <div className="fact-progress">
          <div className="progress-number">{usableConfirmed}</div>
          <div><strong>{t("Confirmed for generation")}</strong></div>
        </div>
      </div>

      <div className="facts-layout">
        <div className="facts-main">
          <div className="summary-card">
            <div className="summary-top"><span className="eyebrow">{t("AI SOURCE BRIEF")}</span><span className="confidence-pill"><span className="status-dot" /> {t("Needs review")}</span></div>
            <h2>{analysis.summaryShort}</h2>
            <p>{analysis.summaryLong}</p>
            <div className="keyword-row">{Array.from(new Set(analysis.keyTerms)).slice(0, 8).map((term) => <span key={term}><Hash size={12} />{term}</span>)}</div>
          </div>

          <div className="facts-list-header">
            <div><h2>{t("Source candidates")}</h2><span>{analysis.facts.length} {t("extracted from")} {sourceText.length.toLocaleString()} {t("source characters")}</span></div>
            <button className="small-button" disabled={!displayed.length} onClick={() => displayed.forEach((fact) => updateFact(fact.id, { verified: true }))}><Check size={14} /> {t("Confirm displayed facts")}</button>
          </div>

          <p className="config-source-note">{t("Matching source excerpts are enabled from your reviewed article. You may adjust the references here and regenerate; existing drafts do not change automatically.")}</p>
          <label className="field-label">{t("Review scope")}<select value={scope} onChange={event => { setScope(event.target.value); setLimit(10); }}>
            <option value="all">{t("All candidates")}</option><option value="pending">{t("Unconfirmed only")}</option><option value="high">{t("High attention")}</option>
          </select></label>
          <p className="config-source-note">{displayed.length} / {filtered.length} · {usableConfirmed} {t("Confirmed for generation")}</p>
          <div className="facts-list">
            {displayed.map((fact) => (
              <div className={`fact-row ${fact.verified ? "verified" : ""}`} key={fact.id}>
                <button aria-label={`${t("Confirm fact")} ${fact.id}`} aria-pressed={fact.verified} className={`fact-checkbox ${fact.verified ? "checked" : ""}`} onClick={() => updateFact(fact.id, { verified: !fact.verified })}>
                  {fact.verified && <Check size={14} />}
                </button>
                <div className="fact-content">
                  <div className="fact-row-top">
                    <span className="fact-id">{fact.id}</span>
                    <span className={`fact-type ${fact.type}`}>{t(fact.type)}</span>
                    <span className={`risk-label ${fact.riskLevel}`}>{fact.riskLevel === "low" ? t("Low risk") : fact.riskLevel === "medium" ? t("Review") : t("High attention")}</span>
                    <span className="fact-location">{fact.sourceLocation}</span>
                  </div>
                  <p className="fact-compact-text">{fact.text}</p>
                  <details className="fact-details"><summary>{t("View source and edit")}</summary>
                  <input className="fact-input" value={fact.text} onChange={(event) => updateFact(fact.id, { text: event.target.value, verified: false })} />
                  <div className="source-excerpt"><BookOpen size={13} /><span>“{fact.sourceExcerpt}”</span></div>
                  <label className="social-toggle"><input type="checkbox" checked={fact.usableOnSocial} onChange={(event) => updateFact(fact.id, { usableOnSocial: event.target.checked })} /><span className="toggle-ui" /> {t("Usable in social outputs")}</label>
                  </details>
                </div>
              </div>
            ))}
          </div>
          {displayed.length < filtered.length && <button className="secondary-button" onClick={() => setLimit(current => current + 10)}>{t("Show 10 more")}</button>}
          {!displayed.length && <p className="config-source-note">{t("No facts match this filter.")}</p>}
        </div>

        <aside className="facts-aside">
          <div className="aside-card risk-card">
            <div className="aside-card-title"><span className="risk-dot" /> {t("Review before publishing")}</div>
            {analysis.riskFlags.length ? <ul>{Array.from(new Set(analysis.riskFlags)).map((flag) => <li key={flag}>{flag}</li>)}</ul> : <p>{t("No risk signals detected in the source.")}</p>}
            <div className="aside-rule" />
            <div className="rule-line"><ShieldCheck size={15} /><span>{t("Unsupported claims will be flagged")}</span></div>
            <div className="rule-line"><ShieldCheck size={15} /><span>{t("Source citations stay attached")}</span></div>
            <div className="rule-line"><ShieldCheck size={15} /><span>{t("Human approval gates export")}</span></div>
          </div>
          <div className="aside-card next-card">
            <span className="eyebrow">{t("NEXT STEP")}</span>
            <h3>{t("Build the distribution pack")}</h3>
            <p>{usableConfirmed} {t("Confirmed for generation")}. {t("Only confirmed facts enabled for social will be used.")}</p>
            <button className="primary-button full" onClick={onGenerate} disabled={loading === "generate" || !usableConfirmed}>
              {loading === "generate" ? <><Loader2 className="spin" size={16} /> {t("Generating pack…")}</> : <><Sparkles size={16} /> {t("Generate confirmed facts")} <ArrowRight size={15} /></>}
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

function AssetsView({ assets, filteredAssets, filter, setFilter, onOpen, onApprove, onGenerate, onExport, loading, usedFallback, pendingPlatforms, targetCount }: { assets: ContentAsset[]; filteredAssets: ContentAsset[]; filter: Platform | "all"; setFilter: (value: Platform | "all") => void; onOpen: (asset: ContentAsset) => void; onApprove: (id: string) => void; onGenerate: () => void; onExport: () => void; loading: string | null; usedFallback: boolean; pendingPlatforms: Platform[]; targetCount: number }) {
  const t = useTranslation();
  const counts = assets.reduce<Record<string, number>>((result, asset) => { result[asset.platform] = (result[asset.platform] || 0) + 1; return result; }, {});
  const pendingForView = pendingPlatforms.filter((platform) => filter === "all" || platform === filter);
  const generating = pendingPlatforms.length > 0;
  return (
    <>
      <div className="page-heading compact-heading assets-heading"><div><div className="eyebrow">{t("STEP 02 / DISTRIBUTION PACK")}</div><h1>{t("Your content")} <em>{t("orbit.")}</em></h1><p>{t("One source, multiple native formats. Review each asset before your team takes it live.")}</p></div><div className="heading-actions"><button className="secondary-button" onClick={onGenerate} disabled={loading === "generate"}>{loading === "generate" ? <><Loader2 className="spin" size={15} /> {t("Generating…")}</> : <><RefreshCw size={15} /> {t("Regenerate")}</>}</button><button className="primary-button" onClick={onExport}><Download size={15} /> {t("Export pack")}</button></div></div>
      {generating && <div className="info-banner generating-banner"><Loader2 className="spin" size={16} /><span><strong>{t("Generating…")}</strong> {pendingPlatforms.length} / {targetCount} {t("channels remaining")}</span></div>}
      {usedFallback && !generating && <div className="info-banner"><Sparkles size={16} /><span><strong>{t("Pack completed with safe local templates.")}</strong> {t("The model was unavailable or returned fewer formats than requested, so missing assets were filled locally. All assets remain editable and require review.")}</span></div>}
      <div className="asset-toolbar"><div className="asset-tabs"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>{t("All assets")} <span>{assets.length}</span></button>{Object.entries(counts).map(([platform, count]) => <button key={platform} className={filter === platform ? "active" : ""} onClick={() => setFilter(platform as Platform)}>{t(PLATFORM_META[platform as Platform].short)} <span>{count}</span></button>)}</div><button className="filter-button"><Filter size={15} /> {t("Needs review")} <ChevronDown size={14} /></button></div>
      {(filteredAssets.length || pendingForView.length) ? <div className="assets-grid">{filteredAssets.map((asset) => { const meta = PLATFORM_META[asset.platform]; return <article className="asset-card" key={asset.id}><div className="asset-card-top"><span className="platform-chip" style={{ "--chip-accent": meta.accent } as React.CSSProperties}>{platformIcon(asset.platform)} {t(meta.label)}</span><button className="card-more"><MoreHorizontal size={17} /></button></div><div className="asset-card-title-row"><h3>{asset.title}</h3><span className={`status-badge ${asset.status}`}>{asset.status === "needs_review" ? t("Review") : t(asset.status.replace("_", " "))}</span></div><span className="asset-type-label">{labelForAsset(asset, t)} · {t(asset.generationMode === "local" ? "Local starter draft" : asset.generationMode === "ai" ? "AI draft" : "Draft")}{asset.riskFlags.length > 0 && ` · ${t("Needs review")}: ${asset.riskFlags.length}`}</span><p className="asset-preview">{asset.content}</p><p className="config-source-note">{t("Preview only — open editor for full copy and production notes.")}</p><div className="asset-card-footer"><span className="source-link"><ShieldCheck size={13} /> {asset.factIds.length} {t("source refs")}</span><div className="card-actions"><button className="edit-button" onClick={() => onOpen(asset)}>{t("Open editor")} <ArrowRight size={14} /></button>{asset.status !== "approved" && <button className="approve-button" aria-label={t("Approve asset")} onClick={() => onApprove(asset.id)}><Check size={15} /></button>}</div></div></article>; })}{pendingForView.map((platform) => <article className="asset-card skeleton" key={`pending-${platform}`}><div className="asset-card-top"><span className="platform-chip" style={{ "--chip-accent": PLATFORM_META[platform].accent } as React.CSSProperties}>{platformIcon(platform)} {t(PLATFORM_META[platform].label)}</span></div><div className="skeleton-line" /><div className="skeleton-line short" /><div className="skeleton-line" /><span className="asset-type-label">{t("Generating…")}</span></article>)}</div> : <div className="empty-state"><Layers3 size={28} /><h3>{t("No assets in this view")}</h3><p>{t("Choose another filter or generate the distribution pack again.")}</p></div>}
    </>
  );
}

function ExportView({ assets, approvedCount, onExport, loading }: { assets: ContentAsset[]; approvedCount: number; onExport: () => void; loading: string | null }) {
  const t = useTranslation();
  const channels = new Set(assets.map((asset) => asset.platform)).size;
  return <><div className="page-heading compact-heading"><div><div className="eyebrow">{t("STEP 03 / HANDOFF")}</div><h1>{t("Ready for")} <em>{t("distribution.")}</em></h1><p>{t("Export a clean content package for your website, social and app teams.")}</p></div><button className="primary-button" onClick={onExport} disabled={!assets.length || loading === "export"}>{loading === "export" ? <><Loader2 className="spin" size={16} /> {t("Packaging…")}</> : <><Download size={16} /> {t("Download ZIP")}</>}</button></div><div className="export-summary"><div className="export-summary-main"><div className="export-icon"><Download size={25} /></div><div><span className="eyebrow">{t("CONTENT PACKAGE")}</span><h2>{assets.length} {t("assets across")} {channels} {t("channels")}</h2><p>{t("Includes the source fact pack, editable Markdown files and project metadata.")}</p></div></div><div className="export-stats"><div><strong>{approvedCount}</strong><span>{t("approved")}</span></div><div><strong>{assets.length - approvedCount}</strong><span>{t("in review")}</span></div><div><strong>{channels}</strong><span>{t("channels")}</span></div></div></div><div className="export-checklist"><div className="checklist-heading"><ClipboardCheck size={18} /><h2>{t("Handoff checklist")}</h2></div>{["Source facts have been reviewed", "Platform copy has a clear CTA", "High-attention claims have a human owner", "Website link is ready to attach"].map((item, index) => <div className="checklist-row" key={item}><span className={`checklist-box ${index < 2 ? "done" : ""}`}>{index < 2 && <Check size={13} />}</span><span>{t(item)}</span><span className={index < 2 ? "check-done" : "check-pending"}>{index < 2 ? t("Complete") : t("Pending")}</span></div>)}</div></>;
}

function SettingsView() {
  const t = useTranslation();
  return <><div className="page-heading compact-heading"><div><div className="eyebrow">{t("WORKSPACE SETTINGS")}</div><h1>{t("Keep the system")} <em>{t("on-brand.")}</em></h1><p>{t("These controls will shape every output generated by the team.")}</p></div></div><div className="settings-grid"><div className="settings-card"><div className="settings-card-icon"><Sparkles size={18} /></div><h2>{t("Brand voice")}</h2><p>{t("Clear, evidence-led, approachable. Never sensational or investment-advisory.")}</p><button className="secondary-button">{t("Edit voice")} <ArrowRight size={14} /></button></div><div className="settings-card"><div className="settings-card-icon"><ShieldCheck size={18} /></div><h2>{t("Safety rules")}</h2><p>{t("Financial, broker, legal and regulatory claims always require human approval.")}</p><button className="secondary-button">{t("Manage rules")} <ArrowRight size={14} /></button></div><div className="settings-card"><div className="settings-card-icon"><Send size={18} /></div><h2>{t("Platform formats")}</h2><p>{t("Character limits, native structures and CTA templates for each channel.")}</p><button className="secondary-button">{t("Configure formats")} <ArrowRight size={14} /></button></div></div></>;
}
