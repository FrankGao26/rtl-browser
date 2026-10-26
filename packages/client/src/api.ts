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

import type {
  ApiResponse, BuildConfig, BuildJobSummary, BuildDiagnostic, DriverPage, FsListing,
  HoverInfo, InstanceNode, InspectorPage, LoadPage, ProjectSummary, ResolveResult,
  SnapshotManifest, SnapshotSummary, SourceWindow, SymbolDefinition,
} from "../../contracts/src/types.js";

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  details?: unknown;
  constructor(code: string, message: string, retryable = false, details?: unknown) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export class RtlClient {
  private csrf = "";
  readonly version: string;
  readonly roots: string[];

  private constructor(csrf: string, version: string, roots: string[]) {
    this.csrf = csrf;
    this.version = version;
    this.roots = roots;
  }

  static async connect(): Promise<RtlClient> {
    const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
    const body = await res.json() as ApiResponse<{ csrfToken: string; version: string; roots: string[] }>;
    if (!body.ok) throw new ApiError(body.error.code, body.error.message, body.error.retryable, body.error.details);
    return new RtlClient(body.data.csrfToken, body.data.version, body.data.roots);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-RTL-CSRF"] = this.csrf;
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload: ApiResponse<T>;
    try {
      payload = await res.json() as ApiResponse<T>;
    } catch {
      throw new ApiError("INTERNAL_ERROR", `HTTP ${res.status}`);
    }
    if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message, payload.error.retryable, payload.error.details);
    return payload.data;
  }

  getWorkspace(): Promise<{ projectRoot: string | null; project: ProjectSummary | null; config: BuildConfig | null; snapshot: SnapshotSummary | null }> {
    return this.req("GET", "/api/workspace");
  }
  openWorkspace(path: string): Promise<{ projectRoot: string; project: ProjectSummary | null; config: BuildConfig | null; snapshot: SnapshotSummary | null }> {
    return this.req("POST", "/api/workspace/open", { path });
  }
  listProjects(): Promise<ProjectSummary[]> { return this.req("GET", "/api/projects"); }
  createProject(config: unknown): Promise<{ project: ProjectSummary; config: BuildConfig }> {
    return this.req("POST", "/api/projects", { config });
  }
  getProject(projectId: string): Promise<{ project: ProjectSummary; config: BuildConfig; current: unknown }> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}`);
  }
  saveConfig(projectId: string, config: unknown, expectedRevision?: number): Promise<{ project: ProjectSummary; config: BuildConfig; snapshotDiscarded: boolean }> {
    return this.req("PUT", `/api/projects/${encodeURIComponent(projectId)}/config`, { config, expectedRevision });
  }
  discardSnapshot(projectId: string): Promise<{ discarded: boolean; project: ProjectSummary; config: BuildConfig }> {
    return this.req("POST", `/api/projects/${encodeURIComponent(projectId)}/snapshot/discard`);
  }
  validateDraft(config: unknown): Promise<{ valid: true; message: string }> {
    return this.req("POST", "/api/workspace/validate", { config });
  }
  build(projectId: string, configRevision: number, requestKey: string): Promise<BuildJobSummary> {
    return this.req("POST", `/api/projects/${encodeURIComponent(projectId)}/build`, { configRevision, requestKey });
  }
  cancel(projectId: string, jobId: string): Promise<BuildJobSummary> {
    return this.req("POST", `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`);
  }
  job(projectId: string, jobId: string): Promise<BuildJobSummary> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`);
  }
  jobs(projectId: string): Promise<BuildJobSummary[]> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/jobs`);
  }
  diagnostics(projectId: string, jobId: string, params: { severity?: string; stage?: string; cursor?: string | null; limit?: number }): Promise<{ records: BuildDiagnostic[]; nextCursor: string | null; complete: boolean; total: number; counts: unknown }> {
    const q = new URLSearchParams();
    if (params.severity) q.set("severity", params.severity);
    if (params.stage) q.set("stage", params.stage);
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.limit) q.set("limit", String(params.limit));
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/diagnostics?${q}`);
  }
  snapshots(projectId: string): Promise<SnapshotSummary[]> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots`);
  }
  async exportSnapshot(projectId: string, snapshotId: string, filename: string): Promise<{ blob: Blob; filename: string }> {
    const q = new URLSearchParams({ filename });
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/export?${q}`,
      { credentials: "same-origin", cache: "no-store" },
    );
    if (!res.ok) {
      let payload: ApiResponse<unknown> | null = null;
      try { payload = await res.json() as ApiResponse<unknown>; } catch { /* binary error */ }
      if (payload && !payload.ok) {
        throw new ApiError(payload.error.code, payload.error.message, payload.error.retryable, payload.error.details);
      }
      throw new ApiError("INTERNAL_ERROR", `HTTP ${res.status}`);
    }
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    let savedName = filename;
    if (star) {
      try { savedName = decodeURIComponent(star[1]); } catch { /* keep requested name */ }
    }
    return { blob: await res.blob(), filename: savedName };
  }
  async importSnapshot(file: Blob): Promise<{ project: ProjectSummary; config: BuildConfig; snapshot: SnapshotSummary }> {
    const res = await fetch("/api/workspace/snapshot/import", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/octet-stream", "X-RTL-CSRF": this.csrf },
      body: file,
    });
    let payload: ApiResponse<{ project: ProjectSummary; config: BuildConfig; snapshot: SnapshotSummary }>;
    try {
      payload = await res.json() as typeof payload;
    } catch {
      throw new ApiError("INTERNAL_ERROR", `HTTP ${res.status}`);
    }
    if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message, payload.error.retryable, payload.error.details);
    return payload.data;
  }
  snapshotInfo(projectId: string, snapshotId: string): Promise<SnapshotManifest> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/info`);
  }
  children(projectId: string, snapshotId: string, parentId: string | null, cursor?: string | null, limit = 200): Promise<{ records: InstanceNode[]; nextCursor: string | null; complete: boolean; total: number | "unknown" }> {
    const q = new URLSearchParams();
    if (parentId) q.set("parentId", parentId);
    if (cursor) q.set("cursor", cursor);
    q.set("limit", String(limit));
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/hierarchy/children?${q}`);
  }
  ancestors(projectId: string, snapshotId: string, instanceId: string): Promise<InstanceNode[]> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/hierarchy/ancestors?instanceId=${encodeURIComponent(instanceId)}`);
  }
  searchHierarchy(projectId: string, snapshotId: string, query: string, limit = 2000): Promise<{ records: InstanceNode[]; total: number; complete: boolean }> {
    const q = new URLSearchParams({ q: query, limit: String(limit) });
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/hierarchy/search?${q}`);
  }
  source(projectId: string, snapshotId: string, params: { sourceId: string; instanceId?: string | null; line?: number; startLine?: number; contextLines?: number; byteOffset?: number; scopeByte?: number; maxBytes?: number }): Promise<SourceWindow> {
    const q = new URLSearchParams({ sourceId: params.sourceId });
    if (params.instanceId) q.set("instanceId", params.instanceId);
    if (params.line) q.set("line", String(params.line));
    if (params.startLine) q.set("startLine", String(params.startLine));
    if (params.contextLines !== undefined) q.set("contextLines", String(params.contextLines));
    if (params.byteOffset !== undefined) q.set("byteOffset", String(params.byteOffset));
    if (params.scopeByte !== undefined && params.scopeByte !== null) q.set("scopeByte", String(params.scopeByte));
    if (params.maxBytes) q.set("maxBytes", String(params.maxBytes));
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/source?${q}`);
  }
  definition(projectId: string, snapshotId: string, symbolId: string): Promise<SymbolDefinition> {
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/definition?symbolId=${encodeURIComponent(symbolId)}`);
  }
  resolve(projectId: string, snapshotId: string, sourceId: string, instanceId: string | null, byteOffset: number): Promise<ResolveResult> {
    const q = new URLSearchParams({ sourceId, byteOffset: String(byteOffset) });
    if (instanceId) q.set("instanceId", instanceId);
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/resolve?${q}`);
  }
  hover(projectId: string, snapshotId: string, params: { occurrenceId?: string; sourceId?: string; instanceId?: string | null; byteOffset?: number }): Promise<HoverInfo> {
    const q = new URLSearchParams();
    if (params.occurrenceId) q.set("occurrenceId", params.occurrenceId);
    if (params.sourceId) q.set("sourceId", params.sourceId);
    if (params.instanceId) q.set("instanceId", params.instanceId);
    if (params.byteOffset !== undefined) q.set("byteOffset", String(params.byteOffset));
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/hover?${q}`);
  }
  drivers(projectId: string, snapshotId: string, instanceId: string, symbolId: string, bitSelection?: string | null, cursor?: string | null, limit = 200): Promise<DriverPage> {
    const q = new URLSearchParams({ instanceId, symbolId, limit: String(limit) });
    if (bitSelection) q.set("bitSelection", bitSelection);
    if (cursor) q.set("cursor", cursor);
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/drivers?${q}`);
  }
  loads(projectId: string, snapshotId: string, instanceId: string, symbolId: string, roles?: string[], bitSelection?: string | null, cursor?: string | null, limit = 200): Promise<LoadPage> {
    const q = new URLSearchParams({ instanceId, symbolId, limit: String(limit) });
    if (roles?.length) q.set("roles", roles.join(","));
    if (bitSelection) q.set("bitSelection", bitSelection);
    if (cursor) q.set("cursor", cursor);
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/loads?${q}`);
  }
  inspector(projectId: string, snapshotId: string, instanceId: string, tab: "ports" | "params" | "children", cursor?: string | null, limit = 200): Promise<InspectorPage> {
    const q = new URLSearchParams({ instanceId, tab, limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.req("GET", `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/inspector?${q}`);
  }
  paths(path?: string | null): Promise<FsListing> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.req("GET", `/api/paths${q}`);
  }
  eventSource(projectId: string): EventSource {
    return new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
  }
}
