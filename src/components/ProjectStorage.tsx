"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { projectSchema, type ProjectSnapshot, type SavedProject } from "@/lib/project-schema";

function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, n => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const lastKey = "polaris-last-project";
export default function ProjectStorage({ snapshot, busy, onRestore }: { snapshot: ProjectSnapshot; busy: boolean; onRestore: (snapshot: ProjectSnapshot) => void }) {
  const t = useTranslation();
  const serialized = JSON.stringify(snapshot);
  const latest = useRef(serialized); latest.current = serialized;
  const restore = useRef(onRestore); restore.current = onRestore;
  const saved = useRef(serialized);
  const project = useRef({ id: "", version: 0 });
  const flight = useRef<Promise<boolean> | null>(null);
  const enabled = useRef(false);
  const conflict = useRef(false);
  const switching = useRef(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Connecting storage…");
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [choice, setChoice] = useState("");
  const [working, setWorking] = useState(false);
  const [, refreshStatus] = useState(0);
  const remember = (id: string) => { try { localStorage.setItem(lastKey, id); } catch { /* History still works without this preference. */ } };
  const refreshHistory = useCallback(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Storage unavailable");
    if (!data.enabled) throw new Error("Database is not configured");
    setProjects(data.projects); return data;
  }, []);

  useEffect(() => {
    const controller = new AbortController(); const initial = latest.current;
    (async () => {
      try {
        const response = await fetch("/api/projects", { signal: controller.signal, cache: "no-store" }); const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Storage unavailable");
        if (!data.enabled) { setStatus("Database is not configured"); return; }
        if (controller.signal.aborted) return;
        setProjects(data.projects); project.current = { id: uuid(), version: 0 };
        let last = ""; try { last = localStorage.getItem(lastKey) || ""; } catch { /* Optional preference. */ }
        if (last && data.projects.some((p: SavedProject) => p.id === last)) {
          const response = await fetch(`/api/projects?id=${encodeURIComponent(last)}`, { signal: controller.signal, cache: "no-store" }); const item = await response.json();
          if (!response.ok) throw new Error(item.error || "Unable to restore project");
          const checked = projectSchema.parse(item.snapshot);
          if (controller.signal.aborted) return;
          // Never replace edits entered while the storage connection was being established.
          if (latest.current === initial) {
            project.current = { id: item.id, version: item.version }; saved.current = JSON.stringify(checked); latest.current = saved.current;
            restore.current(checked); setChoice(item.id);
          }
        }
        enabled.current = true; setReady(true); setStatus(project.current.version ? "Saved to MySQL" : "Ready to save");
      } catch (e) { if (!controller.signal.aborted) { setStatus("Storage unavailable"); setError(e instanceof Error ? e.message : "Storage unavailable"); } }
    })();
    return () => controller.abort();
  }, []);

  const save = useCallback((force = false): Promise<boolean> => {
    if (flight.current) return flight.current;
    if (!enabled.current || conflict.current || switching.current) return Promise.resolve(false);
    const work = async () => {
      setWorking(true); setError("");
      try {
        let mustSave = force;
        while (mustSave || latest.current !== saved.current) {
          mustSave = false;
          const value = latest.current; const current = { ...project.current };
          setStatus("Saving to MySQL…");
          const response = await fetch("/api/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...current, snapshot: JSON.parse(value) }) });
          const result = await response.json();
          if (!response.ok) { if (response.status === 409) conflict.current = true; throw new Error(result.error || "Save failed"); }
          project.current = { id: result.id, version: result.version }; saved.current = value;
          remember(result.id); setChoice(result.id);
        }
        setStatus("Saved to MySQL"); refreshStatus(v => v + 1);
        // Saving succeeded even if a later list refresh has a transient failure.
        void refreshHistory().catch(() => undefined);
        return true;
      } catch (e) { setStatus("Save failed — keep this page open"); setError(e instanceof Error ? e.message : "Save failed"); return false; }
      finally { setWorking(false); }
    };
    flight.current = work().finally(() => { flight.current = null; });
    return flight.current;
  }, [refreshHistory]);

  useEffect(() => {
    if (!ready || serialized === saved.current) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [serialized, ready, save]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (latest.current !== saved.current || flight.current || busy) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [busy]);

  async function loadProject() {
    if (!choice || working || busy) return;
    if (latest.current !== saved.current && !window.confirm(t("Discard unsaved changes and load this project?"))) return;
    const before = latest.current; switching.current = true; setWorking(true); setError("");
    try {
      const response = await fetch(`/api/projects?id=${encodeURIComponent(choice)}`, { cache: "no-store" }); const item = await response.json();
      if (!response.ok) throw new Error(item.error || "Unable to restore project");
      const checked = projectSchema.parse(item.snapshot);
      if (latest.current !== before) throw new Error("The page changed while loading. Please try again.");
      project.current = { id: item.id, version: item.version }; saved.current = JSON.stringify(checked); latest.current = saved.current; conflict.current = false;
      restore.current(checked); remember(item.id); setStatus("Saved to MySQL");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to restore project"); }
    finally { switching.current = false; setWorking(false); }
  }
  async function copyProject() {
    if (working || busy) return;
    // A conflicted tab may save its work as a new project without overwriting the other tab.
    if (!conflict.current && latest.current !== saved.current && !await save()) return;
    project.current = { id: uuid(), version: 0 }; conflict.current = false;
    await save(true);
  }
  const dirty = serialized !== saved.current;
  return <section className="project-storage" aria-label={t("Project storage")}>
    <div><strong>{t("MySQL project history")}</strong><span role="status">{t(dirty && !working && !error && ready ? "Unsaved changes" : status)}</span>
      <small>{project.current.version > 0 ? `ID: ${project.current.id}` : ""}</small></div>
    <div className="storage-actions">
      <button className="small-button" disabled={!ready || working} onClick={() => void save(true)}>{t("Save now")}</button>
      <button className="small-button" disabled={!ready || working || busy} onClick={() => void copyProject()}>{t("Save as new project")}</button>
      <select aria-label={t("Saved projects")} value={choice} onChange={e => setChoice(e.target.value)}><option value="">{t("Choose a saved project")}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name.slice(0,75)} · {p.assetCount} · {p.updatedAt}</option>)}</select>
      <button className="small-button" disabled={!choice || working || busy} onClick={() => void loadProject()}>{t("Restore project")}</button>
      <button className="small-button" disabled={working} onClick={() => void refreshHistory().then(() => { enabled.current = true; if (!project.current.id) project.current.id = uuid(); setReady(true); setError(""); setStatus("Ready to save"); }).catch(e => setError(e.message))}>{t("Refresh history")}</button>
    </div>
    <p>{t("Projects are isolated by browser cookie, not a user login. Save editor changes before closing. Wait for Saved to MySQL before refreshing; running AI jobs do not resume automatically.")}</p>
    {error && <p role="alert" className="storage-error">{t(error)}</p>}
  </section>;
}
