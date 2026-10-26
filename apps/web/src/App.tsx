// Copyright 2026 Frank Gao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BuildConfig, BuildDiagnostic, BuildJobSummary, DriverPage, DriverRecord, HoverInfo,
  InstanceNode, InspectorParam, InspectorPort, LoadPage, LoadRecord, ProjectSummary,
  SemanticRef, SnapshotManifest, SnapshotSummary, SourceWindow,
} from "../../../packages/contracts/src/types.js";
import { RtlClient, ApiError } from "../../../packages/client/src/api.js";
import { targetToUrl, urlToTarget, cleanUrlWithoutToken, type NavTarget } from "../../../packages/navigation/src/history.js";
import { BuildForm } from "../../../packages/ui/src/BuildForm.js";
import { HierarchyTree } from "../../../packages/ui/src/HierarchyTree.js";
import { InspectorPanel } from "../../../packages/ui/src/InspectorPanel.js";
import { SourceViewport, type SourceHighlight } from "../../../packages/ui/src/SourceViewport.js";
import { CompilePanel } from "../../../packages/ui/src/CompilePanel.js";
import { TracePanel } from "../../../packages/ui/src/TracePanel.js";
import { PathPicker } from "../../../packages/ui/src/PathPicker.js";
import { SearchBox } from "../../../packages/ui/src/SearchBox.js";

type ThemeMode = "light" | "dark" | "system";
type Trace = DriverPage | LoadPage;
type TraceHistoryState = {
  snapshotId: string;
  direction: "driver" | "load";
  originInstanceId: string;
  originSymbolId: string;
  bitSelection: string | null;
};
type MenuState = { x: number; y: number; ref: SemanticRef } | null;

function parseTraceHistoryState(value: unknown): TraceHistoryState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.direction !== "driver" && v.direction !== "load") return null;
  if (typeof v.snapshotId !== "string" || typeof v.originInstanceId !== "string" ||
      typeof v.originSymbolId !== "string") return null;
  if (v.bitSelection !== null && typeof v.bitSelection !== "string") return null;
  return {
    snapshotId: v.snapshotId,
    direction: v.direction,
    originInstanceId: v.originInstanceId,
    originSymbolId: v.originSymbolId,
    bitSelection: v.bitSelection as string | null,
  };
}

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED"]);
const ACTIVE = new Set(["QUEUED", "STARTING", "COMPILING", "EXTRACTING", "INDEXING", "VALIDATING", "PUBLISHING"]);
const SIGNAL_KINDS = new Set(["port", "net", "variable", "field"]);
const HIERARCHY_COPY_KINDS = new Set(["port", "net", "variable", "parameter", "localparam"]);

function readNum(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function readTheme(): ThemeMode {
  const v = localStorage.getItem("rtl.theme");
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}
function isEditing(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}
function errorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const [client, setClient] = useState<RtlClient | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [homeOpen, setHomeOpen] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [openPicker, setOpenPicker] = useState(false);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [config, setConfig] = useState<BuildConfig | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotManifest | null>(null);
  const [rootNode, setRootNode] = useState<InstanceNode | null>(null);
  const [current, setCurrent] = useState<InstanceNode | null>(null);
  const [contextLabel, setContextLabel] = useState<string | null>(null);
  const [revealPath, setRevealPath] = useState<InstanceNode[]>([]);
  const [treeEpoch, setTreeEpoch] = useState(0);
  const [sourceWindow, setSourceWindow] = useState<SourceWindow | null>(null);
  const [highlight, setHighlight] = useState<SourceHighlight | null>(null);
  const [sourceAnchor, setSourceAnchor] = useState<{ line: number | null; ratio: number | null }>({ line: null, ratio: null });
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceMatchIndex, setSourceMatchIndex] = useState(0);
  const [hierarchyQuery, setHierarchyQuery] = useState("");
  const [hierarchyMatches, setHierarchyMatches] = useState<InstanceNode[]>([]);
  const [hierarchyMatchIndex, setHierarchyMatchIndex] = useState(0);
  const [hierarchyMatchTotal, setHierarchyMatchTotal] = useState(0);
  const [hierarchySearching, setHierarchySearching] = useState(false);

  const [ports, setPorts] = useState<InspectorPort[]>([]);
  const [params, setParams] = useState<InspectorParam[]>([]);
  const [inspectorTab, setInspectorTab] = useState<"ports" | "params">("ports");
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [inspectorError, setInspectorError] = useState<string | null>(null);

  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const hoverGen = useRef(0);
  const hoverHideTimer = useRef<number | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState>(null);

  const [trace, setTrace] = useState<Trace | null>(null);
  const traceRef = useRef<TraceHistoryState | null>(null);
  const traceRestoreGen = useRef(0);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"trace" | "compile">("compile");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(230);
  const [leftWidth, setLeftWidth] = useState(() => readNum("rtl.leftWidth", 288));
  const [rightWidth, setRightWidth] = useState(() => readNum("rtl.rightWidth", 336));

  const [jobs, setJobs] = useState<BuildJobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [watchJobId, setWatchJobId] = useState<string | null>(null);
  const [job, setJob] = useState<BuildJobSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [diagFilterSeverity, setDiagFilterSeverity] = useState("");
  const [diagFilterStage, setDiagFilterStage] = useState("");
  const [diagCursor, setDiagCursor] = useState<string | null>(null);
  const [diagHasMore, setDiagHasMore] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFailure, setImportFailure] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [highContrast, setHighContrast] = useState(localStorage.getItem("rtl.highContrast") === "1");
  const [globalScale, setGlobalScale] = useState(readNum("rtl.globalScale", 1));
  const [codeScale, setCodeScale] = useState(readNum("rtl.codeScale", 1));

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [navIndex, setNavIndex] = useState(0);
  const [navMax, setNavMax] = useState(0);
  const downStack = useRef<NavTarget[]>([]);
  const [downDepth, setDownDepth] = useState(0);
  const generation = useRef(0);
  const scrollRatioRef = useRef(0);
  const purgedBuildRef = useRef(false);

  useEffect(() => {
    RtlClient.connect()
      .then((c) => {
        cleanUrlWithoutToken();
        setClient(c);
      })
      .catch((e) => setFatal(errorText(e)));
  }, []);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      const ws = await client.getWorkspace();
      if (cancelled) return;
      setWorkspaceRoot(ws.projectRoot);
      setOpenPath(ws.projectRoot ?? "");
      setProjects(ws.project ? [ws.project] : []);
      if (ws.project) {
        const t = urlToTarget();
        const rt = t && t.projectId === ws.project.projectId
          ? await loadProject(ws.project.projectId, t)
          : await loadProject(ws.project.projectId);
        if (rt) replaceHistory(rt);
      }
    })().catch((e) => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const effective = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : theme;
      root.dataset.theme = effective;
      root.dataset.contrast = highContrast ? "high" : "normal";
      root.style.setProperty("--global-scale", String(globalScale));
      root.style.setProperty("--code-scale", String(codeScale));
    };
    apply();
    localStorage.setItem("rtl.theme", theme);
    localStorage.setItem("rtl.highContrast", highContrast ? "1" : "0");
    localStorage.setItem("rtl.globalScale", String(globalScale));
    localStorage.setItem("rtl.codeScale", String(codeScale));
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, highContrast, globalScale, codeScale]);

  const selectedJob = job ?? jobs.find((j) => j.jobId === selectedJobId) ?? null;
  const canJumpDiagnostic = !!snapshot && !!selectedJob?.snapshotId && selectedJob.state === "COMPLETE" && selectedJob.snapshotId === snapshot.snapshotId;

  const replaceHistory = useCallback((t: NavTarget) => {
    history.replaceState({ ...(history.state ?? {}), rtlIndex: 0, rtlTrace: traceRef.current }, "", targetToUrl(t));
    setNavIndex(0);
    setNavMax(0);
  }, []);

  const pushHistory = useCallback((t: NavTarget) => {
    const cur = Number(history.state?.rtlIndex ?? navIndex);
    const idx = cur + 1;
    history.pushState({ rtlIndex: idx, rtlTrace: traceRef.current }, "", targetToUrl(t));
    setNavIndex(idx);
    // pushState truncates the forward history.
    setNavMax(idx);
  }, [navIndex]);

  /**
   * Update the current history entry without adding a token-navigation step.
   * Used by hierarchy selection, trace-row switches and Up/Down.
   */
  const replaceView = useCallback((t: NavTarget) => {
    const cur = Number(history.state?.rtlIndex ?? navIndex);
    history.replaceState({ ...(history.state ?? {}), rtlIndex: cur, rtlTrace: traceRef.current }, "", targetToUrl(t));
    setNavIndex(cur);
    setNavMax((m) => Math.max(m, cur));
  }, [navIndex]);

  const clearDownStack = useCallback(() => {
    if (downStack.current.length === 0) return;
    downStack.current = [];
    setDownDepth(0);
  }, []);

  function applyTrace(next: Trace | null) {
    traceRef.current = next
      ? {
          snapshotId: next.snapshotId,
          direction: next.direction,
          originInstanceId: next.originInstanceId,
          originSymbolId: next.originSymbolId,
          bitSelection: next.bitSelection,
        }
      : null;
    setTrace(next);
  }

  /** Drop the Trace view and cancel any in-flight restore/more request. */
  function clearTrace() {
    traceRestoreGen.current++;
    applyTrace(null);
    setTraceError(null);
    setTraceLoading(false);
  }

  /**
   * Token jumps push a new history entry. Before doing that, rewrite the
   * current entry to the exact source token and scroll position being
   * clicked so Back returns here instead of the module/generate start.
   */
  function rememberSourcePosition(ref: SemanticRef): void {
    if (!project || !snapshot || !sourceWindow) return;
    const line = sourceWindow.lines.find(
      (l) => l.startByte <= ref.startByte && ref.startByte < l.endByte,
    )?.line ?? sourceAnchor.line ?? null;
    replaceView({
      projectId: project.projectId,
      snapshotId: snapshot.snapshotId,
      instanceId: current?.id ?? null,
      sourceId: sourceWindow.sourceId,
      line,
      tokenStart: ref.startByte,
      tokenEnd: ref.endByte,
      scrollRatio: scrollRatioRef.current,
      label: current ? null : contextLabel,
    });
  }

  async function restoreTraceFromHistory(
    projectId: string,
    snapshotId: string,
    state: TraceHistoryState | null,
  ): Promise<void> {
    const gen = ++traceRestoreGen.current;
    if (!state || state.snapshotId !== snapshotId) {
      applyTrace(null);
      setTraceError(null);
      setTraceLoading(false);
      return;
    }
    const c = client;
    if (!c) return;
    applyTrace(null);
    setTraceError(null);
    setTraceLoading(true);
    try {
      const page = state.direction === "driver"
        ? await c.drivers(projectId, snapshotId, state.originInstanceId, state.originSymbolId,
            state.bitSelection, null, 200)
        : await c.loads(projectId, snapshotId, state.originInstanceId, state.originSymbolId,
            undefined, state.bitSelection, null, 200);
      if (gen === traceRestoreGen.current) applyTrace(page);
    } catch (e) {
      if (gen === traceRestoreGen.current) setTraceError(errorText(e));
    } finally {
      if (gen === traceRestoreGen.current) setTraceLoading(false);
    }
  }

  async function loadInspector(projectId: string, snapshotId: string, instanceId: string) {
    setInspectorLoading(true);
    setInspectorError(null);
    try {
      const [p, q] = await Promise.all([
        client!.inspector(projectId, snapshotId, instanceId, "ports"),
        client!.inspector(projectId, snapshotId, instanceId, "params"),
      ]);
      setPorts(p.records as InspectorPort[]);
      setParams(q.records as InspectorParam[]);
    } catch (e) {
      setInspectorError(errorText(e));
    } finally {
      setInspectorLoading(false);
    }
  }

  async function loadFullSource(projectId: string, snapshotId: string, sourceId: string, instanceId: string | null, scopeByte: number | null): Promise<SourceWindow> {
    const lines: SourceWindow["lines"] = [];
    const refs: SemanticRef[] = [];
    const seen = new Set<string>();
    let first: SourceWindow | null = null;
    let startLine = 1;
    let complete = false;
    for (let page = 0; page < 1000; page++) {
      const win = await client!.source(projectId, snapshotId, {
        sourceId, instanceId, startLine, scopeByte: scopeByte ?? undefined, maxBytes: 262144,
      });
      if (!first) first = win;
      for (const line of win.lines) lines.push(line);
      for (const ref of win.refs) {
        if (seen.has(ref.occurrenceId)) continue;
        seen.add(ref.occurrenceId);
        refs.push(ref);
      }
      if (win.complete || win.nextLine === null || win.lines.length === 0) {
        complete = win.complete || win.nextLine === null;
        break;
      }
      startLine = win.nextLine;
    }
    if (!first) throw new Error("source window unavailable");
    return {
      ...first,
      startLine: lines.length ? lines[0].line : first.startLine,
      endLine: lines.length ? lines[lines.length - 1].line : first.endLine,
      lines, refs, truncated: !complete, complete, nextLine: null,
    };
  }

  async function applyTargetInternal(projectId: string, snapshotId: string, target: NavTarget): Promise<NavTarget> {
    const gen = ++generation.current;
    setError(null);
    setHoverInfo(null);
    setMenu(null);
    let instance: InstanceNode | null = null;
    let instanceId = target.instanceId ?? null;
    let sourceId = target.sourceId ?? null;
    let line = target.line ?? null;
    if (instanceId) {
      const path = await client!.ancestors(projectId, snapshotId, instanceId);
      if (gen !== generation.current) return target;
      instance = path[path.length - 1] ?? null;
      if (!instance) throw new Error("当前实例不在快照中");
      setCurrent(instance);
      setContextLabel(null);
      setRevealPath(path);
      if (!sourceId) sourceId = instance.definitionSourceId ?? instance.sourceId;
      if (line === null && (target.byteOffset === null || target.byteOffset === undefined)) {
        line = instance.definitionLine ?? instance.line;
      }
    } else {
      setCurrent(null);
      setContextLabel(target.label ?? null);
      setRevealPath([]);
      setPorts([]);
      setParams([]);
    }
    if (!sourceId) {
      setSourceWindow(null);
      setHighlight(null);
      return { ...target, instanceId, sourceId: null, line };
    }
    const win = await loadFullSource(projectId, snapshotId, sourceId, instanceId, target.tokenStart ?? null);
    if (gen !== generation.current) return target;
    setSourceWindow(win);
    let hl: SourceHighlight | null = null;
    let anchorLine: number | null = line ?? null;
    if (anchorLine === null && target.tokenStart !== null && target.tokenStart !== undefined) {
      const l = win.lines.find((x) => x.startByte <= target.tokenStart! && x.endByte > target.tokenStart!);
      if (l) anchorLine = l.line;
    }
    if (anchorLine === null && target.byteOffset !== null && target.byteOffset !== undefined) {
      const l = win.lines.find((x) => x.startByte <= target.byteOffset! && x.endByte > target.byteOffset!);
      if (l) anchorLine = l.line;
    }
    if (anchorLine !== null) {
      const l = win.lines.find((x) => x.line === anchorLine);
      if (l) hl = { sourceId, startByte: l.startByte, endByte: l.endByte };
    }
    if (target.tokenStart !== null && target.tokenStart !== undefined && target.tokenEnd !== null && target.tokenEnd !== undefined) {
      hl = { sourceId, startByte: target.tokenStart, endByte: target.tokenEnd };
    }
    line = anchorLine ?? win.startLine;
    setHighlight(hl);
    setSourceAnchor({ line, ratio: target.scrollRatio ?? null });
    if (instanceId && instance) {
      if (instance.kind === "instance") await loadInspector(projectId, snapshotId, instanceId);
      else { setPorts([]); setParams([]); }
    }
    return { ...target, instanceId, sourceId, line };
  }

  async function loadSnapshot(projectId: string, snapshotId: string, target?: NavTarget): Promise<NavTarget | null> {
    clearDownStack();
    const info = await client!.snapshotInfo(projectId, snapshotId);
    setSnapshot(info);
    setRootNode(null);
    setCurrent(null);
    setContextLabel(null);
    setSourceWindow(null);
    setHighlight(null);
    setRevealPath([]);
    clearTrace();
    generation.current++;
    const rootPage = await client!.children(projectId, snapshotId, null, null, 200);
    const root = rootPage.records[0] ?? null;
    setRootNode(root);
    const effective: NavTarget | null =
      target && (target.instanceId || target.sourceId) ? target :
      root ? {
        projectId,
        snapshotId,
        instanceId: root.id,
        sourceId: root.definitionSourceId ?? root.sourceId,
        line: root.definitionLine ?? root.line,
        scrollRatio: null,
      } : null;
    if (effective) await applyTargetInternal(projectId, snapshotId, effective);
    return effective;
  }

  async function loadProject(projectId: string, target?: NavTarget): Promise<NavTarget | null> {
    setError(null);
    const r = await client!.getProject(projectId);
    setProject(r.project);
    setConfig(r.config);
    const [sns, js] = await Promise.all([client!.snapshots(projectId), client!.jobs(projectId)]);
    setSnapshots(sns);
    setJobs(js);
    setSelectedJobId(r.project.activeJobId ?? js[0]?.jobId ?? null);
    setWatchJobId(r.project.activeJobId ?? null);
    const cur = r.current as { snapshotId?: string } | null;
    const sid = target?.snapshotId ?? cur?.snapshotId ?? sns[0]?.snapshotId ?? null;
    if (sid) return loadSnapshot(projectId, sid, target);
    setSnapshot(null);
    setRootNode(null);
    setCurrent(null);
    setContextLabel(null);
    setSourceWindow(null);
    clearTrace();
    return null;
  }

  async function navigate(target: NavTarget, push = true): Promise<void> {
    if (!client) return;
    try {
      let actual = target;
      if (target.projectId !== project?.projectId) {
        const rt = await loadProject(target.projectId, target);
        if (rt) actual = rt;
      } else if (target.snapshotId !== snapshot?.snapshotId) {
        const rt = await loadSnapshot(target.projectId, target.snapshotId, target);
        if (rt) actual = rt;
      } else {
        actual = await applyTargetInternal(target.projectId, target.snapshotId, target);
      }
      if (push) pushHistory(actual); else replaceView(actual);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const sourceMatchLines = useMemo(() => {
    const needle = sourceQuery.trim().toLowerCase();
    if (!needle || !sourceWindow) return [];
    return sourceWindow.lines
      .filter((l) => l.active !== false && l.text.toLowerCase().includes(needle))
      .map((l) => l.line);
  }, [sourceQuery, sourceWindow]);
  const sourceMatchSet = useMemo(() => new Set(sourceMatchLines), [sourceMatchLines]);
  const hierarchyMatchIds = useMemo(() => new Set(hierarchyMatches.map((n) => n.id)), [hierarchyMatches]);

  useEffect(() => {
    setSourceMatchIndex(0);
  }, [sourceQuery, sourceWindow?.sourceId]);

  useEffect(() => {
    if (sourceMatchLines.length === 0) setSourceMatchIndex(0);
    else if (sourceMatchIndex >= sourceMatchLines.length) setSourceMatchIndex(0);
  }, [sourceMatchLines.length, sourceMatchIndex]);

  async function jumpSearchNode(node: InstanceNode) {
    if (!project || !snapshot) return;
    clearDownStack();
    await navigate({
      projectId: project.projectId,
      snapshotId: snapshot.snapshotId,
      instanceId: node.id,
      sourceId: node.definitionSourceId ?? node.sourceId,
      line: node.definitionLine ?? node.line,
      scrollRatio: null,
    }, false);
  }

  useEffect(() => {
    const needle = hierarchyQuery.trim();
    if (!needle || !client || !project || !snapshot) {
      setHierarchyMatches([]);
      setHierarchyMatchTotal(0);
      setHierarchyMatchIndex(0);
      setHierarchySearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      (async () => {
        setHierarchySearching(true);
        try {
          const page = await client.searchHierarchy(project.projectId, snapshot.snapshotId, needle, 2000);
          if (cancelled) return;
          setHierarchyMatches(page.records);
          setHierarchyMatchTotal(page.total);
          setHierarchyMatchIndex(0);
          if (page.records[0]) await jumpSearchNode(page.records[0]);
        } catch (e) {
          if (!cancelled) setError(errorText(e));
        } finally {
          if (!cancelled) setHierarchySearching(false);
        }
      })();
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hierarchyQuery, client, project?.projectId, snapshot?.snapshotId]);

  function stepHierarchyMatch(delta: number) {
    if (hierarchyMatches.length === 0) return;
    const next = (hierarchyMatchIndex + delta + hierarchyMatches.length) % hierarchyMatches.length;
    setHierarchyMatchIndex(next);
    void jumpSearchNode(hierarchyMatches[next]);
  }

  useEffect(() => {
    if (history.state?.rtlIndex === undefined) history.replaceState({ rtlIndex: 0, rtlTrace: null }, "", location.href);
  }, []);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      clearDownStack();
      const idx = Number(e.state?.rtlIndex ?? 0);
      setNavIndex(Number.isFinite(idx) ? idx : 0);
      const t = urlToTarget();
      const traceState = parseTraceHistoryState(e.state?.rtlTrace);
      if (t) {
        clearTrace();
        void (async () => {
          try {
            if (t.projectId !== project?.projectId) {
              await loadProject(t.projectId, t);
            } else if (t.snapshotId !== snapshot?.snapshotId) {
              await loadSnapshot(t.projectId, t.snapshotId, t);
            } else {
              await applyTargetInternal(t.projectId, t.snapshotId, t);
            }
            await restoreTraceFromHistory(t.projectId, t.snapshotId, traceState);
          } catch (err) { setError(errorText(err)); }
        })();
      } else {
        clearTrace();
        setProject(null); setConfig(null); setSnapshot(null);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.projectId, snapshot?.snapshotId]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest(".context-menu")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditing(e.target)) return;
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); if (navIndex > 0) history.back(); }
      else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); if (navIndex < navMax) history.forward(); }
      else if (e.key === "Escape") { setMenu(null); clearHoverNow(); setAppearanceOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navIndex, navMax]);

  useEffect(() => {
    if (!client || !project || !watchJobId) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const j = await client.job(project.projectId, watchJobId);
        if (cancelled) return;
        setJob(j);
        setJobs((prev) => [j, ...prev.filter((x) => x.jobId !== j.jobId)]);
        if (TERMINAL.has(j.state)) {
          setWatchJobId(null);
          const list = await client.jobs(project.projectId);
          if (!cancelled) setJobs(list);
          const sns = await client.snapshots(project.projectId);
          if (!cancelled) setSnapshots(sns);
          setProject((p) => p ? { ...p, activeJobId: null } : p);
          if (j.state === "COMPLETE" && j.snapshotId) {
            const rt = await loadSnapshot(project.projectId, j.snapshotId);
            if (rt) replaceHistory(rt);
            purgedBuildRef.current = false;
            setNotice("编译与索引发布完成，工程已可浏览。");
          } else if (j.state === "FAILED") {
            setPanelTab("compile");
            setBottomOpen(true);
            const wasPurged = purgedBuildRef.current;
            purgedBuildRef.current = false;
            setNotice(wasPurged
              ? "本次构建失败；旧快照已随配置变更清除。"
              : "本次构建失败；旧成功快照（如有）保持不变。");
          }
          return;
        }
        timer = window.setTimeout(tick, 600);
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    };
    void tick();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, project?.projectId, watchJobId]);

  useEffect(() => {
    if (!client || !project || !selectedJobId || panelTab !== "compile") return;
    let cancelled = false;
    setDiagLoading(true);
    client.diagnostics(project.projectId, selectedJobId, { severity: diagFilterSeverity || undefined, stage: diagFilterStage || undefined, limit: 200 })
      .then((page) => {
        if (cancelled) return;
        setDiagnostics(page.records);
        setDiagCursor(page.nextCursor);
        setDiagHasMore(!page.complete);
      })
      .catch((e) => { if (!cancelled) setError(errorText(e)); })
      .finally(() => { if (!cancelled) setDiagLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, project?.projectId, selectedJobId, diagFilterSeverity, diagFilterStage, panelTab]);

  function clearSnapshotView() {
    setSnapshot(null);
    setRootNode(null);
    setCurrent(null);
    setContextLabel(null);
    setRevealPath([]);
    setSourceWindow(null);
    setHighlight(null);
    clearTrace();
    setPorts([]);
    setParams([]);
  }

  async function onSaved(p: ProjectSummary, c: BuildConfig, snapshotDiscarded = false) {
    setProject(p);
    setConfig(c);
    setWorkspaceRoot(p.projectRoot);
    setOpenPath(p.projectRoot);
    const [ps, sns, js] = await Promise.all([client!.listProjects(), client!.snapshots(p.projectId), client!.jobs(p.projectId)]);
    setProjects(ps); setSnapshots(sns); setJobs(js);
    if (snapshotDiscarded) {
      clearSnapshotView();
      setSelectedJobId(null);
      setJob(null);
      setWatchJobId(null);
      setSettingsOpen(false);
      setPanelTab("compile");
      setBottomOpen(true);
      history.replaceState({ rtlIndex: 0, rtlTrace: null }, "", location.pathname);
      setNavIndex(0);
      setNavMax(0);
      setNotice("配置已更改，旧快照已删除，请重新编译。");
    }
  }

  function onBuildStarted(j: BuildJobSummary) {
    clearDownStack();
    setSettingsOpen(false);
    setHomeOpen(false);
    setProject((p) => p ? { ...p, activeJobId: j.jobId } : p);
    setWatchJobId(j.jobId);
    setJob(j);
    setJobs((prev) => j.purged ? [j] : [j, ...prev.filter((x) => x.jobId !== j.jobId)]);
    setSelectedJobId(j.jobId);
    purgedBuildRef.current = !!j.purged;
    setPanelTab("compile");
    setBottomOpen(true);
    if (j.purged) {
      setSnapshot(null); setSnapshots([]); setRootNode(null); setCurrent(null); setContextLabel(null);
      setSourceWindow(null); setHighlight(null); clearTrace(); setPorts([]); setParams([]);
      history.replaceState({ rtlIndex: 0, rtlTrace: null }, "", location.pathname);
      setNavIndex(0); setNavMax(0);
    }
    setNotice(`构建任务 ${j.jobId.slice(0, 8)} 已启动。`);
  }

  async function startTopBuild() {
    if (!client || !project) return;
    try {
      const j = await client.build(project.projectId, config?.configRevision ?? project.configRevision, crypto.randomUUID());
      onBuildStarted(j);
    } catch (e) { setError(errorText(e)); }
  }

  async function openDirectory(raw: string) {
    if (!client || !raw.trim()) return;
    setOpening(true);
    setError(null);
    try {
      const ws = await client.openWorkspace(raw.trim());
      setWorkspaceRoot(ws.projectRoot);
      setOpenPath(ws.projectRoot);
      setHomeOpen(false);
      if (ws.project) {
        setProject(ws.project);
        setConfig(ws.config);
        const t = urlToTarget();
        const rt = t && t.projectId === ws.project.projectId
          ? await loadProject(ws.project.projectId, t)
          : await loadProject(ws.project.projectId);
        if (rt) replaceHistory(rt);
        else history.replaceState({ rtlIndex: 0, rtlTrace: null }, "", location.pathname);
      } else {
        setProject(null); setConfig(null); setProjects([]); setSnapshots([]); setJobs([]);
        setSelectedJobId(null); setWatchJobId(null); setJob(null);
        setSnapshot(null); setRootNode(null); setCurrent(null); setContextLabel(null); setRevealPath([]);
        setSourceWindow(null); setHighlight(null); clearTrace(); setPorts([]); setParams([]);
        history.replaceState({ rtlIndex: 0, rtlTrace: null }, "", location.pathname);
        setNavIndex(0); setNavMax(0);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOpening(false);
    }
  }

  async function importSnapshotFile(file: File | null) {
    if (!client || !workspaceRoot || !file) return;
    setImporting(true);
    setImportFailure(null);
    setError(null);
    try {
      const result = await client.importSnapshot(file);
      setProject(result.project);
      setConfig(result.config);
      setWorkspaceRoot(result.project.projectRoot);
      setOpenPath(result.project.projectRoot);
      setProjects([result.project]);
      setSnapshots([result.snapshot]);
      setHomeOpen(false);
      const rt = await loadProject(result.project.projectId);
      if (rt) replaceHistory(rt);
      else history.replaceState({ rtlIndex: 0, rtlTrace: null }, "", location.pathname);
      setNotice(`已从快照 ${result.snapshot.snapshotId} 恢复编译后的界面，未运行编译。`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "SNAPSHOT_VERSION_MISMATCH") {
        setImportFailure("快照版本与当前程序不匹配，未打开任何内容。请使用生成该快照的程序版本打开。");
      } else {
        setImportFailure(`无法打开快照：${errorText(e)}`);
      }
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  async function exportCurrentSnapshot() {
    if (!client || !project || !snapshot) return;
    const requested = exportName.trim().replace(/\.rtlbsnap$/i, "");
    const submitName = requested || snapshot.topModule || "snapshot";
    setExporting(true);
    setError(null);
    try {
      const { blob, filename } = await client.exportSnapshot(project.projectId, snapshot.snapshotId, submitName);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setExportOpen(false);
      setNotice(`快照已导出为 ${filename}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  }

  async function cancelActive() {
    if (!client || !project) return;
    const id = selectedJobId ?? project.activeJobId;
    if (!id) return;
    try {
      const j = await client.cancel(project.projectId, id);
      setJob(j);
      setNotice("已请求取消构建。");
    } catch (e) { setError(errorText(e)); }
  }

  async function selectNode(node: InstanceNode) {
    if (!project || !snapshot) return;
    clearDownStack();
    // Hierarchy selection is ordinary browsing; only jumpable source tokens
    // create token-navigation history entries.
    await navigate({
      projectId: project.projectId,
      snapshotId: snapshot.snapshotId,
      instanceId: node.id,
      sourceId: node.definitionSourceId ?? node.sourceId,
      line: node.definitionLine ?? node.line,
      scrollRatio: null,
    }, false);
  }

  async function resetToTop() {
    if (!client || !project || !snapshot) return;
    try {
      setHomeOpen(false);
      clearDownStack();
      const rt = await loadSnapshot(project.projectId, snapshot.snapshotId);
      if (rt) replaceHistory(rt);
      setTreeEpoch((n) => n + 1);
    } catch (e) { setError(errorText(e)); }
  }

  function currentViewTarget(): NavTarget | null {
    if (!project || !snapshot || !current) return null;
    return {
      projectId: project.projectId,
      snapshotId: snapshot.snapshotId,
      instanceId: current.id,
      sourceId: sourceWindow?.sourceId ?? current.definitionSourceId ?? current.sourceId,
      line: sourceAnchor.line ?? current.definitionLine ?? current.line,
      scrollRatio: sourceAnchor.ratio,
    };
  }

  async function goUp() {
    if (!current?.parentId || !project || !snapshot) return;
    const child = currentViewTarget();
    if (child) {
      downStack.current.push(child);
      setDownDepth(downStack.current.length);
    }
    await navigate({
      projectId: project.projectId,
      snapshotId: snapshot.snapshotId,
      instanceId: current.parentId,
      sourceId: current.sourceId,
      line: current.line,
      scrollRatio: null,
    }, false);
  }

  async function goDown() {
    const target = downStack.current.pop();
    setDownDepth(downStack.current.length);
    if (!target) return;
    await navigate(target, false);
  }

  async function selectRef(ref: SemanticRef) {
    if (!project || !snapshot) return;
    clearDownStack();
    rememberSourcePosition(ref);
    try {
      if (ref.kind === "package" && ref.targetSourceId) {
        // Packages have no instance hierarchy; drop the previous module
        // context so the title and "copy hierarchy" show the package name.
        await navigate({
          projectId: project.projectId,
          snapshotId: snapshot.snapshotId,
          instanceId: null,
          sourceId: ref.targetSourceId,
          line: ref.targetLine ?? 1,
          tokenStart: ref.targetStartByte,
          tokenEnd: ref.targetEndByte,
          scrollRatio: null,
          label: ref.label,
        }, true);
        return;
      }
      if (ref.targetKind === "symbol" && ref.targetSymbolKind && SIGNAL_KINDS.has(ref.targetSymbolKind)) {
        const page = await openDriverAndJump(ref);
        if (page && page.records.length > 0) return;
      }
      if (ref.targetKind === "instance" && ref.targetId) {
        const path = await client!.ancestors(project.projectId, snapshot.snapshotId, ref.targetId);
        const leaf = path[path.length - 1];
        if (!leaf) throw new Error("实例目标不存在");
        await navigate({
          projectId: project.projectId,
          snapshotId: snapshot.snapshotId,
          instanceId: leaf.id,
          sourceId: leaf.definitionSourceId ?? leaf.sourceId,
          line: leaf.definitionLine ?? leaf.line,
          scrollRatio: null,
        }, true);
        return;
      }
      if (ref.targetSourceId) {
        await navigate({
          projectId: project.projectId,
          snapshotId: snapshot.snapshotId,
          instanceId: ref.targetInstanceId ?? current?.id ?? null,
          sourceId: ref.targetSourceId,
          line: ref.targetLine ?? 1,
          tokenStart: ref.targetStartByte,
          tokenEnd: ref.targetEndByte,
          scrollRatio: null,
        }, true);
      } else {
        setNotice("该目标没有可导航的源码位置。");
      }
    } catch (e) { setError(errorText(e)); }
  }

  function clearHoverTimer() {
    if (hoverHideTimer.current !== undefined) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = undefined;
    }
  }

  function clearHoverNow() {
    clearHoverTimer();
    hoverGen.current++;
    setHoverInfo(null);
  }

  function scheduleHoverHide() {
    clearHoverTimer();
    hoverHideTimer.current = window.setTimeout(() => {
      hoverHideTimer.current = undefined;
      hoverGen.current++;
      setHoverInfo(null);
    }, 220);
  }

  async function onRefHover(ref: SemanticRef | null, e?: React.MouseEvent) {
    if (!ref || !client || !project || !snapshot) {
      if (!ref) scheduleHoverHide();
      return;
    }
    clearHoverTimer();
    if (e) setHoverPos({ x: e.clientX, y: e.clientY });
    const gen = ++hoverGen.current;
    try {
      const info = await client.hover(project.projectId, snapshot.snapshotId, {
        occurrenceId: ref.occurrenceId,
        instanceId: current?.id ?? null,
      });
      if (gen === hoverGen.current) setHoverInfo(info);
    } catch (err) {
      if (gen === hoverGen.current) setHoverInfo({ status: "unresolved", title: "", declaration: null, sourceLine: null, kind: null, typeText: null, width: null, signed: null, packedDims: null, unpackedDims: null, direction: null, defaultValue: null, actualValue: null, macroBody: null, targetInstanceId: null, targetSourceId: null, targetLine: null, message: errorText(err) });
    }
  }

  async function resolveRefSymbol(ref: SemanticRef): Promise<string | null> {
    if (ref.targetKind === "symbol" && ref.targetId) return ref.targetId;
    if (!client || !project || !snapshot || !sourceWindow) return null;
    const r = await client.resolve(project.projectId, snapshot.snapshotId, sourceWindow.sourceId, current?.id ?? null, ref.startByte);
    return r.targetKind === "symbol" ? r.targetId : null;
  }

  async function openTrace(kind: "driver" | "load", ref: SemanticRef, jumpFirst = false, jumpPush = false): Promise<Trace | null> {
    if (!client || !project || !snapshot || !current) {
      setTraceError("需要先选择一个实例中的信号。");
      setPanelTab("trace");
      setBottomOpen(true);
      return null;
    }
    const requestGen = ++traceRestoreGen.current;
    setTraceLoading(true); setTraceError(null);
    try {
      const symbolId = await resolveRefSymbol(ref);
      if (!symbolId) throw new Error("该 token 没有解析到信号符号");
      const page = kind === "driver"
        ? await client.drivers(project.projectId, snapshot.snapshotId, current.id, symbolId, null, null, 200)
        : await client.loads(project.projectId, snapshot.snapshotId, current.id, symbolId, undefined, null, null, 200);
      if (requestGen !== traceRestoreGen.current) return null;
      applyTrace(page);
      setPanelTab("trace");
      setBottomOpen(true);
      if (jumpFirst && page.records[0]) {
        // A port actual can itself be the first driver record; jumping there
        // would look like nothing happened. Prefer the first driver whose
        // source token differs from the clicked one, while keeping all rows.
        const sameToken = (r: DriverRecord | LoadRecord) =>
          "sourceId" in r && !!sourceWindow &&
          r.sourceId === sourceWindow.sourceId &&
          r.startByte !== null && r.endByte !== null &&
          r.startByte === ref.startByte && r.endByte === ref.endByte;
        const target = page.records.find((r) => !sameToken(r));
        if (target) await jumpTrace(target, page.originInstanceId, jumpPush);
        else setNotice("首个 driver 与点击位置相同；Trace 已列出全部记录。");
      }
      return page;
    } catch (e) {
      if (requestGen === traceRestoreGen.current) {
        setTraceError(errorText(e));
        setPanelTab("trace");
        setBottomOpen(true);
      }
      return null;
    } finally {
      if (requestGen === traceRestoreGen.current) setTraceLoading(false);
    }
  }

  async function openDriverAndJump(ref: SemanticRef): Promise<Trace | null> {
    return openTrace("driver", ref, true, true);
  }

  async function traceMore() {
    if (!client || !project || !snapshot || !trace || !trace.nextCursor) return;
    const requestGen = ++traceRestoreGen.current;
    const currentTrace = trace;
    setTraceLoading(true);
    try {
      if (currentTrace.direction === "driver") {
        const page = await client.drivers(project.projectId, snapshot.snapshotId, currentTrace.originInstanceId, currentTrace.originSymbolId, currentTrace.bitSelection, currentTrace.nextCursor, 200);
        if (requestGen === traceRestoreGen.current) {
          applyTrace({ ...page, records: [...currentTrace.records, ...page.records] });
        }
      } else {
        const page = await client.loads(project.projectId, snapshot.snapshotId, currentTrace.originInstanceId, currentTrace.originSymbolId, undefined, currentTrace.bitSelection, currentTrace.nextCursor, 200);
        if (requestGen === traceRestoreGen.current) {
          applyTrace({ ...page, records: [...currentTrace.records, ...page.records] });
        }
      }
    } catch (e) {
      if (requestGen === traceRestoreGen.current) setTraceError(errorText(e));
    } finally {
      if (requestGen === traceRestoreGen.current) setTraceLoading(false);
    }
  }

  /**
   * Switch the viewport to one Trace row. Only the initial jump caused by
   * clicking a source token pushes history; subsequent row switches replace
   * the current view so Back/Forward remain token-navigation only.
   */
  async function jumpTrace(record: DriverRecord | LoadRecord, originInstanceId?: string, pushHistoryEntry = false) {
    if (!snapshot) return;
    clearDownStack();
    const origin = originInstanceId ?? trace?.originInstanceId ?? current?.id ?? null;
    if ("sourceId" in record) {
      await navigate({
        projectId: snapshot.projectId,
        snapshotId: snapshot.snapshotId,
        instanceId: record.sourceInstanceId ?? origin,
        sourceId: record.sourceId,
        line: record.line,
        byteOffset: record.startByte,
        tokenStart: record.startByte,
        tokenEnd: record.endByte,
        scrollRatio: null,
      }, pushHistoryEntry);
    } else {
      await navigate({
        projectId: snapshot.projectId,
        snapshotId: snapshot.snapshotId,
        instanceId: record.targetInstanceId ?? origin,
        sourceId: record.targetSourceId,
        byteOffset: record.targetStartByte,
        tokenStart: record.targetStartByte,
        tokenEnd: record.targetEndByte,
        scrollRatio: null,
      }, pushHistoryEntry);
    }
  }

  async function loadMoreDiagnostics() {
    if (!client || !project || !selectedJobId || !diagCursor) return;
    setDiagLoading(true);
    try {
      const page = await client.diagnostics(project.projectId, selectedJobId, {
        severity: diagFilterSeverity || undefined, stage: diagFilterStage || undefined,
        cursor: diagCursor, limit: 200,
      });
      setDiagnostics((prev) => [...prev, ...page.records]);
      setDiagCursor(page.nextCursor);
      setDiagHasMore(!page.complete);
    } catch (e) { setError(errorText(e)); }
    finally { setDiagLoading(false); }
  }

  function jumpDiagnostic(d: BuildDiagnostic) {
    if (!snapshot || !d.primaryLocation) return;
    const src = snapshot.sources.find((s) => s.displayPath === d.primaryLocation!.displayPath);
    if (!src) { setError("该诊断位置不在已发布快照的源码闭包中。"); return; }
    clearDownStack();
    void navigate({
      projectId: snapshot.projectId,
      snapshotId: snapshot.snapshotId,
      sourceId: src.sourceId,
      line: d.primaryLocation.line,
      instanceId: null,
      scrollRatio: null,
    }, true);
  }

  function copyHierarchy() {
    const value = current?.path ?? contextLabel;
    if (!value) return;
    navigator.clipboard.writeText(value)
      .then(() => setNotice(current ? "已复制当前实例层次。" : "已复制 package 名。"))
      .catch((e) => setError(errorText(e)));
  }

  function copyPath() {
    if (!sourceWindow) return;
    navigator.clipboard.writeText(sourceWindow.displayPath)
      .then(() => setNotice("已复制源码文件路径。"))
      .catch((e) => setError(errorText(e)));
  }

  function canCopyHierarchy(ref: SemanticRef): boolean {
    if (ref.targetKind === "instance") return !!ref.targetId;
    return !!current && ref.targetKind === "symbol" && !!ref.targetId &&
      !!ref.targetSymbolKind && HIERARCHY_COPY_KINDS.has(ref.targetSymbolKind);
  }

  async function copyObjectHierarchy(ref: SemanticRef) {
    if (!client || !project || !snapshot) return;
    try {
      let path: string | null = null;
      if (ref.targetKind === "instance" && ref.targetId) {
        const chain = await client.ancestors(project.projectId, snapshot.snapshotId, ref.targetId);
        path = chain[chain.length - 1]?.path ?? null;
      } else if (canCopyHierarchy(ref) && ref.targetId && current) {
        const def = await client.definition(project.projectId, snapshot.snapshotId, ref.targetId);
        let name = def.status === "resolved" ? def.label : null;
        if (name && ref.kind === "member" && ref.label) {
          const member = ref.label.split(" = ")[0].trim();
          if (member) name = `${name}.${member}`;
        }
        if (name) path = `${current.path}.${name}`;
      }
      if (!path) {
        setNotice("该对象没有可复制的层次路径。");
        return;
      }
      await navigator.clipboard.writeText(path);
      setNotice(`已复制层次：${path}`);
    } catch (e) { setError(errorText(e)); }
  }

  async function jumpToSymbolDefinition(symbolId: string): Promise<void> {
    if (!client || !project || !snapshot) return;
    const def = await client.definition(project.projectId, snapshot.snapshotId, symbolId);
    if (def.status !== "resolved" || !def.sourceId) {
      setNotice(def.message ?? "该符号没有可跳转的源码定义。");
      return;
    }
    await navigate({
      projectId: project.projectId,
      snapshotId: snapshot.snapshotId,
      instanceId: current?.id ?? null,
      sourceId: def.sourceId,
      line: def.line ?? 1,
      tokenStart: def.startByte,
      tokenEnd: def.endByte,
      scrollRatio: null,
    }, true);
  }

  async function gotoDefinition(ref: SemanticRef) {
    if (!client || !project || !snapshot) return;
    clearDownStack();
    rememberSourcePosition(ref);
    try {
      const symbolId = ref.targetKind === "symbol" ? ref.targetId : await resolveRefSymbol(ref);
      if (!symbolId) { setNotice("该 token 没有解析到符号定义。"); return; }
      await jumpToSymbolDefinition(symbolId);
    } catch (e) { setError(errorText(e)); }
  }

  async function selectInspectorSymbol(symbolId: string) {
    clearDownStack();
    try {
      await jumpToSymbolDefinition(symbolId);
    } catch (e) { setError(errorText(e)); }
  }

  async function menuAction(action: "driver" | "load" | "definition" | "up" | "hierarchy") {
    if (!menu) return;
    const ref = menu.ref;
    setMenu(null);
    if (action === "driver") {
      rememberSourcePosition(ref);
      await openDriverAndJump(ref);
    }
    else if (action === "load") await openTrace("load", ref);
    else if (action === "definition") await gotoDefinition(ref);
    else if (action === "up") await goUp();
    else await copyObjectHierarchy(ref);
  }

  useEffect(() => {
    localStorage.setItem("rtl.leftWidth", String(Math.round(leftWidth)));
    localStorage.setItem("rtl.rightWidth", String(Math.round(rightWidth)));
  }, [leftWidth, rightWidth]);

  function startColumnResize(side: "left" | "right", e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftWidth : rightWidth;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (side === "left") setLeftWidth(Math.min(720, Math.max(180, startW + dx)));
      else setRightWidth(Math.min(720, Math.max(220, startW - dx)));
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    const move = (ev: MouseEvent) => setPanelHeight(Math.min(620, Math.max(120, startH - (ev.clientY - startY))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function resetHistoryHome() {
    setHomeOpen(true);
    setSettingsOpen(false);
  }

  const sourceContext = current?.path ?? contextLabel;
  const sourceTitle = sourceWindow
    ? (sourceContext ? `${sourceContext} (${sourceWindow.displayPath})` : sourceWindow.displayPath)
    : "—";

  const showHome = !workspaceRoot || homeOpen;
  const compileView = (
    <CompilePanel
      jobs={jobs}
      selectedJobId={selectedJobId}
      diagnostics={diagnostics}
      filterSeverity={diagFilterSeverity}
      filterStage={diagFilterStage}
      loading={diagLoading}
      canJump={canJumpDiagnostic}
      onSelectJob={(id) => { setSelectedJobId(id); setJob(null); }}
      onFilterSeverity={setDiagFilterSeverity}
      onFilterStage={setDiagFilterStage}
      onCancel={() => void cancelActive()}
      onJump={jumpDiagnostic}
      onMore={() => void loadMoreDiagnostics()}
      hasMore={diagHasMore}
    />
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <input
          ref={importInputRef}
          type="file"
          accept=".rtlbsnap,application/vnd.rtlb.snapshot"
          style={{ display: "none" }}
          onChange={(e) => void importSnapshotFile(e.target.files?.[0] ?? null)}
        />
        <button className="brand" onClick={resetHistoryHome} title="首页">RTL Browser</button>
        {workspaceRoot && <span className="project-chip" title={workspaceRoot}>{snapshot?.topModule ?? workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot}</span>}
        {snapshot && <span className="snapshot-chip">snapshot <span className="mono">{snapshot.snapshotId}</span></span>}
        <div className="top-actions">
          <div className="nav-controls" role="group" aria-label="页面导航">
            <button onClick={() => history.back()} disabled={navIndex <= 0} title="后退 (Alt+Left)" aria-label="后退">←</button>
            <button onClick={() => history.forward()} disabled={navIndex >= navMax} title="前进 (Alt+Right)" aria-label="前进">→</button>
            <span className="nav-sep" aria-hidden="true" />
            <button
              onClick={() => void goUp()}
              disabled={!current?.parentId}
              title="向上：跳到父实例化位置"
              aria-label="Up"
            >↑</button>
            <button
              onClick={() => void goDown()}
              disabled={downDepth === 0}
              title={downDepth === 0 ? "向下：先按 Up 才有可返回的子模块" : "向下：返回按 Up 之前的子模块"}
              aria-label="Down"
            >↓</button>
            <button onClick={() => void resetToTop()} disabled={!snapshot} title="回到顶层并折叠层次树" aria-label="Top">Top</button>
          </div>
          <span className="top-divider" aria-hidden="true" />
          <div className="project-actions" role="group" aria-label="工程操作">
            <button onClick={() => setHomeOpen(true)}>打开目录</button>
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={!workspaceRoot || importing}
              title="从 .rtlbsnap 快照恢复编译后的界面，不重新编译"
            >
              {importing ? "导入中…" : "从快照打开…"}
            </button>
            <button
              onClick={() => { setExportName(snapshot?.topModule ?? "snapshot"); setExportOpen(true); }}
              disabled={!snapshot}
              title="将当前快照导出为单个 .rtlbsnap 文件"
            >
              导出快照
            </button>
            <button onClick={() => setSettingsOpen(true)} disabled={!project}>工程设置</button>
            <button className="primary" onClick={() => void startTopBuild()} disabled={!project || !!project.activeJobId}>编译并建立索引</button>
            {selectedJob && ACTIVE.has(selectedJob.state) && <button onClick={() => void cancelActive()}>取消构建</button>}
            <button onClick={() => setAppearanceOpen((v) => !v)}>外观</button>
          </div>
        </div>
      </header>

      {fatal && <div className="fatal">{fatal}<br /><span className="muted">请从启动器输出的带 token URL 打开本页面。</span></div>}
      {error && <div className="banner error" onClick={() => setError(null)}>{error} <span className="dismiss">×</span></div>}
      {notice && <div className="banner notice" onClick={() => setNotice(null)}>{notice} <span className="dismiss">×</span></div>}

      <div className="app-body">
        {showHome ? (
          <main className="home">
            <section className="home-card">
              <h1>打开工程目录</h1>
              <p className="muted">选择一个包含 RTL 的目录作为工程根。每次启动都从空白构建表单开始；本次会话状态只写入 <span className="mono">.rtlb/sessions/&lt;id&gt;</span>，正常退出即删除。无写权限时不会打开。运行时不使用 AI，不修改源文件。</p>
              {!client ? <div className="panel-empty">正在连接后端…</div> : (
                <>
                  <div className="form-grid">
                    <label className="wide">工程目录
                      <span className="input-with-button">
                        <input value={openPath} onChange={(e) => setOpenPath(e.target.value)} placeholder="输入绝对路径，或点击浏览…" />
                        <button onClick={() => setOpenPicker(true)}>浏览…</button>
                      </span>
                      <span className="field-help">主界面一次只打开一个工程；每个服务进程使用独立的会话目录，同一目录可启动多个服务进程编译不同设计。页面刷新会恢复本会话状态，服务重启后不恢复旧配置或快照。</span>
                    </label>
                    <div className="form-actions">
                      <button className="primary" disabled={opening || !openPath.trim()} onClick={() => void openDirectory(openPath)}>{opening ? "打开中…" : "打开工程"}</button>
                      {workspaceRoot && <button onClick={() => setHomeOpen(false)}>返回当前工程</button>}
                    </div>
                  </div>
                  {workspaceRoot && <div className="form-status"><span>当前目录：<span className="mono">{workspaceRoot}</span></span></div>}
                </>
              )}
            </section>
            {openPicker && client && (
              <PathPicker
                client={client}
                mode="directory"
                onPick={(p) => { setOpenPath(p); setOpenPicker(false); }}
                onClose={() => setOpenPicker(false)}
              />
            )}
          </main>
        ) : !snapshot ? (
          <main className="empty-workspace">
            <h2>尚无可浏览工程</h2>
            <p className="muted">本次工程只有在编译成功且完整索引发布后才进入浏览区，也可以直接导入已有的 <span className="mono">.rtlbsnap</span> 快照恢复编译后的界面。失败任务只在 Compile 中报告。</p>
            <section className="snapshot-import-card">
              <div>
                <strong>从快照打开</strong>
                <p className="muted">快照文件自包含，可改名或移动。仅当快照版本与当前程序匹配时才会恢复，不运行编译。</p>
              </div>
              <button
                className="primary"
                disabled={!workspaceRoot || importing}
                onClick={() => importInputRef.current?.click()}
                title={workspaceRoot ? "选择 .rtlbsnap 文件" : "请先打开工程目录"}
              >
                {importing ? "导入中…" : "选择快照文件…"}
              </button>
            </section>
            {client && <BuildForm key={`${project?.projectId ?? "new"}-${config?.configRevision ?? 0}`} client={client} project={project} config={config} projectRoot={workspaceRoot} onSaved={(p, c, discarded) => onSaved(p, c, discarded)} onBuild={onBuildStarted} onError={setError} />}
            <section className="empty-compile">
              <div className="panel-tabs"><strong>Compile</strong><span className="muted">本次工程尚未发布，仅显示构建报告</span></div>
              {compileView}
            </section>
          </main>
        ) : (
          <>
            <div className="workspace" style={{ bottom: bottomOpen ? panelHeight + 10 : 44 }}>
              <aside className="left-pane" style={{ width: leftWidth, flexBasis: leftWidth }}>
                <div className="pane-title pane-title-search">
                  <span>Hierarchy</span>
                  <SearchBox
                    value={hierarchyQuery}
                    onChange={setHierarchyQuery}
                    onNext={() => stepHierarchyMatch(1)}
                    onPrev={() => stepHierarchyMatch(-1)}
                    index={hierarchyMatchIndex}
                    total={hierarchyMatchTotal}
                    placeholder={hierarchySearching ? "搜索中…" : "搜索层次…"}
                    title="按名称、模块名或层次路径搜索；自动定位到第一个匹配"
                  />
                </div>
                <HierarchyTree
                  client={client!}
                  projectId={project!.projectId}
                  snapshotId={snapshot.snapshotId}
                  selectedId={current?.id ?? null}
                  revealPath={revealPath}
                  searchMatchIds={hierarchyMatchIds}
                  resetToken={treeEpoch}
                  onSelect={(n) => void selectNode(n)}
                  onRoot={(n) => setRootNode(n)}
                />
              </aside>
              <div className="v-resize left-resize" onMouseDown={(e) => startColumnResize("left", e)} title="拖动调整层次窗口宽度" />
              <section className="source-pane">
                <div className="source-toolbar">
                  <span className="source-title mono" title={sourceTitle}>{sourceTitle}</span>
                  {sourceWindow && <span className="source-range muted">{sourceWindow.startLine}–{sourceWindow.endLine} / {sourceWindow.totalLines}</span>}
                  {sourceWindow?.truncated && <span className="warn-text">窗口已截断</span>}
                  <span className="spacer" />
                  <SearchBox
                    value={sourceQuery}
                    onChange={setSourceQuery}
                    onNext={() => setSourceMatchIndex((i) => sourceMatchLines.length ? (i + 1) % sourceMatchLines.length : 0)}
                    onPrev={() => setSourceMatchIndex((i) => sourceMatchLines.length ? (i - 1 + sourceMatchLines.length) % sourceMatchLines.length : 0)}
                    index={sourceMatchIndex}
                    total={sourceMatchLines.length}
                    placeholder="搜索源码…"
                    disabled={!sourceWindow}
                    title="在当前源码文件中搜索；自动跳到第一个匹配行"
                  />
                  <button onClick={copyHierarchy} disabled={!current && !contextLabel}>复制层次</button>
                  <button onClick={copyPath} disabled={!sourceWindow}>复制路径</button>
                </div>
                {sourceWindow ? (
                  <SourceViewport
                    window={sourceWindow}
                    highlight={highlight}
                    onRefHover={(r, e) => void onRefHover(r, e)}
                    onRefContext={(r, e) => setMenu({ x: e.clientX, y: e.clientY, ref: r })}
                    onRefClick={(r) => void selectRef(r)}
                    onScrollRatio={(r) => { scrollRatioRef.current = r; }}
                    restoreScrollRatio={sourceAnchor.ratio}
                    layoutKey={`${globalScale}-${codeScale}`}
                    searchLines={sourceMatchSet}
                    searchLine={sourceMatchLines[sourceMatchIndex] ?? null}
                    searchQuery={sourceQuery}
                  />
                ) : (
                  <div className="panel-empty">加载源码中…</div>
                )}
              </section>
              <div className="v-resize right-resize" onMouseDown={(e) => startColumnResize("right", e)} title="拖动调整检查器宽度" />
              <aside className="right-pane" style={{ width: rightWidth, flexBasis: rightWidth }}>
                <InspectorPanel
                  instance={current}
                  tab={inspectorTab}
                  onTab={setInspectorTab}
                  ports={ports}
                  params={params}
                  loading={inspectorLoading}
                  error={inspectorError}
                  onSelect={(symbolId) => void selectInspectorSymbol(symbolId)}
                />
              </aside>
            </div>
  
            <section className={`bottom-panel${bottomOpen ? "" : " collapsed"}`} style={{ height: bottomOpen ? panelHeight : 38 }}>
              <div className="panel-resize" onMouseDown={startResize} title="拖动调整高度" />
              <div className="panel-tabs">
                <button className={panelTab === "trace" ? "active" : ""} onClick={() => { setPanelTab("trace"); setBottomOpen(true); }}>Trace</button>
                <button className={panelTab === "compile" ? "active" : ""} onClick={() => { setPanelTab("compile"); setBottomOpen(true); }}>Compile</button>
                <span className="spacer" />
                <button onClick={() => setBottomOpen((v) => !v)}>{bottomOpen ? "折叠" : "展开"}</button>
              </div>
              {bottomOpen && (
                <div className="panel-body">
                  {panelTab === "trace" ? (
                    <TracePanel trace={trace} loading={traceLoading} error={traceError} onJump={(r) => void jumpTrace(r)} onMore={() => void traceMore()} />
                  ) : compileView}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {exportOpen && snapshot && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setExportOpen(false); }}>
          <div className="modal export-modal" role="dialog" aria-label="导出快照">
            <div className="modal-head"><strong>导出快照</strong><button className="icon-btn" onClick={() => setExportOpen(false)}>×</button></div>
            <p className="muted">导出一个自包含的 <span className="mono">.rtlbsnap</span> 文件，可改名或移动到其他位置；文件类型固定，不可选择。</p>
            <label>文件名
              <span className="filename-input">
                <input
                  autoFocus
                  value={exportName}
                  onChange={(e) => setExportName(e.target.value.replace(/\.rtlbsnap$/i, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") void exportCurrentSnapshot(); }}
                  aria-label="快照文件名"
                />
                <span className="mono fixed-suffix">.rtlbsnap</span>
              </span>
            </label>
            <div className="form-actions">
              <button onClick={() => setExportOpen(false)}>取消</button>
              <button className="primary" onClick={() => void exportCurrentSnapshot()} disabled={exporting}>
                {exporting ? "导出中…" : "下载快照"}
              </button>
            </div>
          </div>
        </div>
      )}

      {importFailure && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setImportFailure(null); }}>
          <div className="modal error-modal" role="dialog" aria-label="无法打开快照">
            <div className="modal-head"><strong>无法打开快照</strong><button className="icon-btn" onClick={() => setImportFailure(null)}>×</button></div>
            <p>{importFailure}</p>
            <div className="form-actions"><button className="primary" onClick={() => setImportFailure(null)}>关闭</button></div>
          </div>
        </div>
      )}

      {settingsOpen && project && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="modal settings-modal" role="dialog" aria-label="工程设置">
            <div className="modal-head"><strong>工程设置 / 编译</strong><button className="icon-btn" onClick={() => setSettingsOpen(false)}>×</button></div>
            <BuildForm
              key={`${project.projectId}-${config?.configRevision ?? 0}`}
              client={client!}
              project={project}
              config={config}
              projectRoot={workspaceRoot}
              onSaved={(p, c, discarded) => onSaved(p, c, discarded)}
              onBuild={onBuildStarted}
              onError={setError}
            />
          </div>
        </div>
      )}

      {appearanceOpen && (
        <div className="appearance-popover" role="dialog" aria-label="外观设置">
          <div className="modal-head"><strong>外观</strong><button className="icon-btn" onClick={() => setAppearanceOpen(false)}>×</button></div>
          <label>主题
            <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeMode)}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={highContrast} onChange={(e) => setHighContrast(e.target.checked)} />高对比度</label>
          <label>全局字体 {Math.round(globalScale * 100)}%
            <input type="range" min={75} max={200} step={5} value={Math.round(globalScale * 100)} onChange={(e) => setGlobalScale(Number(e.target.value) / 100)} />
          </label>
          <label>源码相对字号 {Math.round(codeScale * 100)}%
            <input type="range" min={75} max={200} step={5} value={Math.round(codeScale * 100)} onChange={(e) => setCodeScale(Number(e.target.value) / 100)} />
          </label>
          <button onClick={() => { setTheme("system"); setHighContrast(false); setGlobalScale(1); setCodeScale(1); }}>恢复默认</button>
        </div>
      )}

      {hoverInfo && hoverPos && (
        <div
          className="hover-card"
          style={{ left: Math.min(hoverPos.x + 14, window.innerWidth - 380), top: Math.min(hoverPos.y + 18, window.innerHeight - 300) }}
          onMouseEnter={clearHoverTimer}
          onMouseLeave={scheduleHoverHide}
        >
          <div className="hover-title">{hoverInfo.title || hoverInfo.kind || "未解析"}</div>
          {hoverInfo.status !== "resolved" && <div className="muted">{hoverInfo.message ?? hoverInfo.status}</div>}
          {hoverInfo.sourceLine && <div className="mono hover-decl">{hoverInfo.sourceLine}</div>}
          {hoverInfo.macroBody && <pre className="macro-body">{hoverInfo.macroBody}</pre>}
          <div className="hover-meta">
            {hoverInfo.typeText && <span>{hoverInfo.typeText}</span>}
            {hoverInfo.width !== null && <span>宽度 {hoverInfo.width}</span>}
            {hoverInfo.signed !== null && <span>{hoverInfo.signed ? "signed" : "unsigned"}</span>}
            {hoverInfo.direction && <span>{hoverInfo.direction}</span>}
          </div>
          {hoverInfo.defaultValue !== null && <div>默认值 <span className="mono">{hoverInfo.defaultValue || "（空串）"}</span></div>}
          {hoverInfo.actualValue !== null && (
            hoverInfo.actualValue !== hoverInfo.defaultValue ||
            hoverInfo.kind === "parameter" ||
            hoverInfo.kind === "localparam" ||
            hoverInfo.kind === "type_parameter"
          ) && (
            <div>
              实际值 <span className="mono">{hoverInfo.actualValue || "（空串）"}</span>
              {hoverInfo.actualValue === hoverInfo.defaultValue &&
                <span className="muted">（与默认相同）</span>}
            </div>
          )}
        </div>
      )}

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => undefined}>
          <button onClick={() => void menuAction("driver")} disabled={!current}>Driver — 追来源</button>
          <button onClick={() => void menuAction("load")} disabled={!current}>Load — 追目的端</button>
          {menu.ref.targetKind === "symbol" && menu.ref.role !== "declaration" &&
            <button onClick={() => void menuAction("definition")} disabled={!menu.ref.targetId}>转到定义位置</button>}
          <button onClick={() => void menuAction("up")} disabled={!current?.parentId}>Up — 父实例化位置</button>
          {canCopyHierarchy(menu.ref) && <button onClick={() => void menuAction("hierarchy")}>复制当前层次</button>}
        </div>
      )}
    </div>
  );
}
