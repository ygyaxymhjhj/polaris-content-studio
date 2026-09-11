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
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Video,
  X,
  Zap
} from "lucide-react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { LocaleContext, translate, UiLanguage, useTranslation } from "@/lib/i18n";
import JSZip from "jszip";
import { alignSourceConfig, ImportedSource } from "@/lib/source-config";
import {
  ContentAsset,
  DEFAULT_PLATFORMS,
  FactItem,
  PLATFORM_META,
  Platform,
  ProjectConfig,
  SourceAnalysis
} from "@/lib/types";

const sampleArticle = `The financial regulator has announced a new framework for gold trading platforms. The framework will take effect on 1 July 2025 and introduces clearer disclosure requirements for brokers serving retail traders. Platforms will need to explain fees, order execution and withdrawal conditions in a more visible way. The regulator said the changes are designed to improve transparency and help users compare platforms more confidently. Brokers and traders should review the official requirements before making operational changes. The full framework and implementation notes are available from the regulator's public notice.`;

type View = "workspace" | "facts" | "assets" | "export" | "settings";

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "workspace", label: "Workspace", icon: LayoutDashboard },
  { id: "facts", label: "Source & facts", icon: ClipboardCheck },
  { id: "assets", label: "Content assets", icon: Layers3 },
  { id: "export", label: "Export center", icon: Download }
];

const platformGroups: { label: string; platforms: Platform[] }[] = [
  { label: "Web & social", platforms: ["website", "facebook", "threads", "linkedin", "x", "instagram"] },
  { label: "App & video", platforms: ["short_video", "community", "push", "kol_live", "faq"] }
];

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
  const [config, setConfig] = useState<ProjectConfig>(initialConfig);
  const editedConfig = useRef(new Set<keyof ProjectConfig>());
  const importedSource = useRef<ImportedSource | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>(DEFAULT_PLATFORMS);
  const [selectedAsset, setSelectedAsset] = useState<ContentAsset | null>(null);
  const [deliveryDraft, setDeliveryDraft] = useState("{}");
  const [assetFilter, setAssetFilter] = useState<Platform | "all">("all");
  const [loading, setLoading] = useState<"parse" | "fetch" | "analyze" | "generate" | "export" | null>(null);
  const [toast, setToast] = useState("");
  const [usedFallback, setUsedFallback] = useState(false);

  const verifiedCount = analysis?.facts.filter((fact) => fact.verified).length || 0;
  const approvedCount = assets.filter((asset) => asset.status === "approved").length;
  const filteredAssets = useMemo(
    () => assetFilter === "all" ? assets : assets.filter((asset) => asset.platform === assetFilter),
    [assetFilter, assets]
  );

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function updateConfig(field: keyof ProjectConfig, value: string) {
    editedConfig.current.add(field);
    setConfig((current) => {
      const next = { ...current, [field]: value };
      return field === "language" && importedSource.current
        ? alignSourceConfig(next, importedSource.current, editedConfig.current)
        : next;
    });
  }

  function clearDerivedContent() {
    setAnalysis(null);
    setAssets([]);
    setSelectedAsset(null);
    setAssetFilter("all");
    setUsedFallback(false);
  }

  function importSource(source: ImportedSource, filename: string) {
    importedSource.current = source;
    setSourceText(source.text);
    setSourceName(filename);
    setConfig((current) => alignSourceConfig(current, source, editedConfig.current));
    clearDerivedContent();
  }

  function editSourceText(text: string) {
    const source = { text };
    importedSource.current = source;
    setSourceText(text);
    setSourceName("");
    setConfig((current) => alignSourceConfig(current, source, editedConfig.current));
    clearDerivedContent();
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
    importSource({ text: sampleArticle, title: "New Gold Regulation: What Traders Need to Know" }, "sample-gold-regulation.txt");
    notify("Sample article loaded.");
  }

  async function fetchArticle() {
    if (!config.sourceUrl.trim()) {
      notify("Add an article URL first.");
      return;
    }
    setLoading("fetch");
    try {
      let response = await fetch("/api/fetch-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: config.sourceUrl }) });
      let data = await response.json();
      if (!response.ok && ["ANTI_BOT_VERIFICATION", "ARTICLE_CONTENT_INCOMPLETE"].includes(data.code)) {
        notify("This page needs human verification. Opening the browser crawler…");
        response = await fetch("/api/crawl-article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: config.sourceUrl }) });
        data = await response.json();
      }
      if (!response.ok) throw new Error(data.error || "Unable to fetch article");
      importSource({ ...data, sourceUrl: data.sourceUrl || config.sourceUrl }, data.title ? `${data.title}.url` : config.sourceUrl);
      notify(`${(data.characterCount || data.text?.length || 0).toLocaleString()} ${t("characters imported")}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Unable to fetch article"));
    } finally {
      setLoading(null);
    }
  }

  async function runDemo() {
    const demoSource = { text: sampleArticle, title: "New Gold Regulation: What Traders Need to Know" };
    const demoConfig = alignSourceConfig(config, demoSource, editedConfig.current);
    importSource(demoSource, "sample-gold-regulation.txt");
    setLoading("analyze");
    try {
      const analysisResponse = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ article: sampleArticle, title: demoConfig.title }) });
      const sourceAnalysis = await analysisResponse.json() as SourceAnalysis;
      if (!analysisResponse.ok) throw new Error("Demo analysis failed");
      const confirmed = { ...sourceAnalysis, facts: sourceAnalysis.facts.map((fact) => ({ ...fact, verified: true })) };
      setAnalysis(confirmed);
      setLoading("generate");
      const generationResponse = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: demoConfig, analysis: confirmed, platforms: selectedPlatforms }) });
      const result = await generationResponse.json();
      if (!generationResponse.ok) throw new Error(result.error || "Demo generation failed");
      setAssets(result.assets || []);
      setUsedFallback(Boolean(result.usedFallback));
      setView("assets");
      notify("Demo content pack ready to inspect.");
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Demo failed"));
    } finally {
      setLoading(null);
    }
  }

  async function analyzeArticle() {
    if (!sourceText.trim()) {
      notify("Add an article first. You can paste text or import a DOCX.");
      return;
    }
    setLoading("analyze");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article: sourceText, title: config.title })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Analysis failed");
      setAnalysis(data);
      setView("facts");
      notify("Source mapped. Confirm the facts before content generation.");
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Analysis failed"));
    } finally {
      setLoading(null);
    }
  }

  function updateFact(id: string, patch: Partial<FactItem>) {
    setAnalysis((current) => current ? { ...current, facts: current.facts.map((fact) => fact.id === id ? { ...fact, ...patch } : fact) } : current);
  }

  async function generateContent(analysisToUse: SourceAnalysis = analysis as SourceAnalysis) {
    if (!analysisToUse) return;
    setLoading("generate");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, analysis: analysisToUse, platforms: selectedPlatforms })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Generation failed");
      setAssets(data.assets || []);
      setUsedFallback(Boolean(data.usedFallback));
      setView("assets");
      notify(data.usedFallback ? t("Draft pack generated with local templates. Add an AI key for model generation.") : t("Content pack generated and ready for review."));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Generation failed"));
    } finally {
      setLoading(null);
    }
  }

  async function approveFactsAndGenerate() {
    if (!analysis) return;
    const confirmed = { ...analysis, facts: analysis.facts.map((fact) => ({ ...fact, verified: true })) };
    setAnalysis(confirmed);
    await generateContent(confirmed);
  }

  function saveAsset() {
    if (!selectedAsset) return;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(deliveryDraft);
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid notes");
    } catch { notify(t("Delivery notes must be a valid JSON object.")); return; }
    setAssets((current) => current.map((asset) => asset.id === selectedAsset.id ? { ...selectedAsset, meta, status: "needs_review", updatedAt: new Date().toISOString() } : asset));
    setSelectedAsset(null);
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
              {id === "facts" && analysis && <span className="nav-count">{verifiedCount}/{analysis.facts.length}</span>}
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
            <AssetsView assets={assets} filteredAssets={filteredAssets} filter={assetFilter} setFilter={setAssetFilter} onOpen={(asset) => { setSelectedAsset(asset); setDeliveryDraft(JSON.stringify(asset.meta || {}, null, 2)); }} onApprove={approveAsset} onGenerate={() => analysis && generateContent()} onExport={() => setView("export")} loading={loading} usedFallback={usedFallback} />
          )}
          {view === "export" && <ExportView assets={assets} approvedCount={approvedCount} onExport={exportPackage} loading={loading} />}
          {view === "settings" && <SettingsView />}
        </div>
      </main>

      {selectedAsset && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedAsset(null); }}>
          <aside className="asset-drawer">
            <div className="drawer-header">
              <div><span className="eyebrow">{t("EDIT ASSET")}</span><h2>{t(PLATFORM_META[selectedAsset.platform].label)}</h2></div>
              <button className="icon-button" onClick={() => setSelectedAsset(null)}><X size={18} /></button>
            </div>
            <div className="drawer-meta"><span className="platform-chip" style={{ "--chip-accent": PLATFORM_META[selectedAsset.platform].accent } as React.CSSProperties}>{platformIcon(selectedAsset.platform)} {labelForAsset(selectedAsset, t)}</span><span className={`status-badge ${selectedAsset.status}`}>{t(selectedAsset.status.replace("_", " "))}</span></div>
            <label className="field-label">{t("Title / internal name")}<input value={selectedAsset.title} onChange={(event) => updateSelectedAsset("title", event.target.value)} /></label>
            <label className="field-label">{t("Content")}<textarea className="drawer-textarea" value={selectedAsset.content} onChange={(event) => updateSelectedAsset("content", event.target.value)} /></label>
            <label className="field-label">{t("CTA")}<input value={selectedAsset.cta || ""} onChange={(event) => updateSelectedAsset("cta", event.target.value)} /></label>
            {selectedAsset.deepLink !== undefined && <label className="field-label">{t("Deep link")}<input value={selectedAsset.deepLink || ""} onChange={(event) => updateSelectedAsset("deepLink", event.target.value)} /></label>}
            <div className="drawer-section"><div className="field-label">{t("Source references")}</div><div className="reference-list">{selectedAsset.factIds.length ? selectedAsset.factIds.map((id) => <span key={id} className="fact-reference"><ShieldCheck size={13} /> {id}</span>) : <span className="muted">{t("No references attached")}</span>}</div></div>
            {selectedAsset.meta && <div className="drawer-section"><div className="field-label">{t("Delivery notes")}</div><div className="delivery-notes">{Object.entries(selectedAsset.meta).map(([key, value]) => <div key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><strong>{metaValue(value)}</strong></div>)}</div></div>}
            <label className="field-label">{t("Edit delivery notes (JSON)")}<textarea className="drawer-textarea" value={deliveryDraft} onChange={event => setDeliveryDraft(event.target.value)} /></label>
            {!!selectedAsset.riskFlags.length && <div className="info-banner"><div><strong>{t("Review before publishing")}</strong><ul>{selectedAsset.riskFlags.map((flag, index) => <li key={index}>{flag}</li>)}</ul></div></div>}
            <div className="drawer-footer"><button className="secondary-button" onClick={() => setSelectedAsset(null)}>{t("Cancel")}</button><button className="primary-button" onClick={saveAsset}><Check size={16} /> {t("Save changes")}</button></div>
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

      <section className="panel source-panel">
        <div className="section-heading"><div><span className="step-number">01</span><div className="heading-copy"><h2>{t("Bring in your source")}</h2><p>{t("This article remains the single source of truth for every output.")}</p></div></div><div className="heading-links"><button className="text-button" onClick={loadSample}><Sparkles size={15} /> {t("Load sample")}</button><button className="text-button demo-link" onClick={runDemo} disabled={loading !== null}><Play size={14} fill="currentColor" /> {t("Preview full demo")}</button></div></div>
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
              <label className="field-label">{t("Category")}<select aria-label={t("Category")} value={config.category} onChange={(event) => updateConfig("category", event.target.value)}><option value="">{t("Select category")}</option><option value="Gold">{t("Gold")}</option><option value="Forex">{t("Forex")}</option><option value="Broker">{t("Broker")}</option><option value="Scam alert">{t("Scam alert")}</option><option value="KOL LIVE">{t("KOL LIVE")}</option><option value="Point Mall">{t("Point Mall")}</option></select></label>
              <label className="field-label">{t("Language")}<select aria-label={t("Language")} value={config.language} onChange={(event) => updateConfig("language", event.target.value as ProjectConfig["language"])}><option value="en">{t("English")}</option><option value="vi">{t("Vietnamese")}</option><option value="zh">{t("Chinese")}</option></select></label>
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
        <div className="panel-actions"><span className="action-note"><ShieldCheck size={15} /> {t("Human approval is required before export")}</span><button className="primary-button large" onClick={analyzeArticle} disabled={loading === "analyze"}>{loading === "analyze" ? <><Loader2 className="spin" size={17} /> {t("Mapping source…")}</> : <><Sparkles size={17} /> {t("Analyze source")} <ArrowRight size={16} /></>}</button></div>
        {hasAnalysis && <button className="existing-analysis" onClick={() => goTo("facts")}>{t("View existing source analysis")} <ArrowRight size={14} /></button>}
      </section>
    </>
  );
}

function FactsView({ analysis, sourceText, updateFact, onGenerate, loading }: { analysis: SourceAnalysis; sourceText: string; updateFact: (id: string, patch: Partial<FactItem>) => void; onGenerate: () => void; loading: string | null }) {
  const t = useTranslation();
  const confirmed = analysis.facts.filter((fact) => fact.verified).length;
  const progress = (confirmed / Math.max(analysis.facts.length, 1)) * 100;

  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <div className="eyebrow">{t("STEP 01 / SOURCE CONTROL")}</div>
          <h1>{t("Confirm the")} <em>{t("source truth.")}</em></h1>
          <p>{t("Every generated sentence is grounded in this map. Confirm what is safe to publish before moving on.")}</p>
        </div>
        <div className="fact-progress">
          <div className="progress-number">{confirmed}<span>/{analysis.facts.length}</span></div>
          <div>
            <strong>{t("facts confirmed")}</strong>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
        </div>
      </div>

      <div className="facts-layout">
        <div className="facts-main">
          <div className="summary-card">
            <div className="summary-top"><span className="eyebrow">{t("AI SOURCE BRIEF")}</span><span className="confidence-pill"><span className="status-dot" /> {t("High confidence")}</span></div>
            <h2>{analysis.summaryShort}</h2>
            <p>{analysis.summaryLong}</p>
            <div className="keyword-row">{Array.from(new Set(analysis.keyTerms)).slice(0, 8).map((term) => <span key={term}><Hash size={12} />{term}</span>)}</div>
          </div>

          <div className="facts-list-header">
            <div><h2>{t("Key facts")}</h2><span>{analysis.facts.length} {t("extracted from")} {sourceText.length.toLocaleString()} {t("source characters")}</span></div>
            <button className="small-button" onClick={() => analysis.facts.forEach((fact) => updateFact(fact.id, { verified: true }))}><Check size={14} /> {t("Confirm all")}</button>
          </div>

          <div className="facts-list">
            {analysis.facts.map((fact) => (
              <div className={`fact-row ${fact.verified ? "verified" : ""}`} key={fact.id}>
                <button className={`fact-checkbox ${fact.verified ? "checked" : ""}`} onClick={() => updateFact(fact.id, { verified: !fact.verified })}>
                  {fact.verified && <Check size={14} />}
                </button>
                <div className="fact-content">
                  <div className="fact-row-top">
                    <span className="fact-id">{fact.id}</span>
                    <span className={`fact-type ${fact.type}`}>{t(fact.type)}</span>
                    <span className={`risk-label ${fact.riskLevel}`}>{fact.riskLevel === "low" ? t("Low risk") : fact.riskLevel === "medium" ? t("Review") : t("High attention")}</span>
                    <span className="fact-location">{fact.sourceLocation}</span>
                  </div>
                  <input className="fact-input" value={fact.text} onChange={(event) => updateFact(fact.id, { text: event.target.value })} />
                  <div className="source-excerpt"><BookOpen size={13} /><span>“{fact.sourceExcerpt}”</span></div>
                  <label className="social-toggle"><input type="checkbox" checked={fact.usableOnSocial} onChange={(event) => updateFact(fact.id, { usableOnSocial: event.target.checked })} /><span className="toggle-ui" /> {t("Usable in social outputs")}</label>
                </div>
              </div>
            ))}
          </div>
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
            <p>{t("Generate tailored content for every selected channel.")}</p>
            <button className="primary-button full" onClick={onGenerate} disabled={loading === "generate"}>
              {loading === "generate" ? <><Loader2 className="spin" size={16} /> {t("Generating pack…")}</> : <><Sparkles size={16} /> {t("Approve & generate")} <ArrowRight size={15} /></>}
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

function AssetsView({ assets, filteredAssets, filter, setFilter, onOpen, onApprove, onGenerate, onExport, loading, usedFallback }: { assets: ContentAsset[]; filteredAssets: ContentAsset[]; filter: Platform | "all"; setFilter: (value: Platform | "all") => void; onOpen: (asset: ContentAsset) => void; onApprove: (id: string) => void; onGenerate: () => void; onExport: () => void; loading: string | null; usedFallback: boolean }) {
  const t = useTranslation();
  const counts = assets.reduce<Record<string, number>>((result, asset) => { result[asset.platform] = (result[asset.platform] || 0) + 1; return result; }, {});
  return (
    <>
      <div className="page-heading compact-heading assets-heading"><div><div className="eyebrow">{t("STEP 02 / DISTRIBUTION PACK")}</div><h1>{t("Your content")} <em>{t("orbit.")}</em></h1><p>{t("One source, multiple native formats. Review each asset before your team takes it live.")}</p></div><div className="heading-actions"><button className="secondary-button" onClick={onGenerate} disabled={loading === "generate"}><RefreshCw size={15} /> {t("Regenerate")}</button><button className="primary-button" onClick={onExport}><Download size={15} /> {t("Export pack")}</button></div></div>
      {usedFallback && <div className="info-banner"><Sparkles size={16} /><span><strong>{t("Pack completed with safe local templates.")}</strong> {t("The model was unavailable or returned fewer formats than requested, so missing assets were filled locally. All assets remain editable and require review.")}</span></div>}
      <div className="asset-toolbar"><div className="asset-tabs"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>{t("All assets")} <span>{assets.length}</span></button>{Object.entries(counts).map(([platform, count]) => <button key={platform} className={filter === platform ? "active" : ""} onClick={() => setFilter(platform as Platform)}>{t(PLATFORM_META[platform as Platform].short)} <span>{count}</span></button>)}</div><button className="filter-button"><Filter size={15} /> {t("Needs review")} <ChevronDown size={14} /></button></div>
      {filteredAssets.length ? <div className="assets-grid">{filteredAssets.map((asset) => { const meta = PLATFORM_META[asset.platform]; return <article className="asset-card" key={asset.id}><div className="asset-card-top"><span className="platform-chip" style={{ "--chip-accent": meta.accent } as React.CSSProperties}>{platformIcon(asset.platform)} {t(meta.label)}</span><button className="card-more"><MoreHorizontal size={17} /></button></div><div className="asset-card-title-row"><h3>{asset.title}</h3><span className={`status-badge ${asset.status}`}>{asset.status === "needs_review" ? t("Review") : t(asset.status.replace("_", " "))}</span></div><span className="asset-type-label">{labelForAsset(asset, t)} · {t(asset.generationMode === "local" ? "Local starter draft" : asset.generationMode === "ai" ? "AI draft" : "Draft")}{asset.riskFlags.length > 0 && ` · ${t("Needs review")}: ${asset.riskFlags.length}`}</span><p className="asset-preview">{asset.content}</p><p className="config-source-note">{t("Preview only — open editor for full copy and production notes.")}</p><div className="asset-card-footer"><span className="source-link"><ShieldCheck size={13} /> {asset.factIds.length} {t("source refs")}</span><div className="card-actions"><button className="edit-button" onClick={() => onOpen(asset)}>{t("Open editor")} <ArrowRight size={14} /></button>{asset.status !== "approved" && <button className="approve-button" aria-label={t("Approve asset")} onClick={() => onApprove(asset.id)}><Check size={15} /></button>}</div></div></article>; })}</div> : <div className="empty-state"><Layers3 size={28} /><h3>{t("No assets in this view")}</h3><p>{t("Choose another filter or generate the distribution pack again.")}</p></div>}
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
