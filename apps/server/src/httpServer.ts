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

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, asAppError, errorResponse } from "../../../packages/contracts/src/errors.js";
import { LIMITS } from "../../../packages/contracts/src/limits.js";
import type { FsListing, SnapshotSummary } from "../../../packages/contracts/src/types.js";
import { BuildManager, type BuildEvent, type DiagnosticsFilter } from "../../../packages/core/src/buildManager.js";
import { normalizeDraft, validateConfigForBuild } from "../../../packages/core/src/config.js";
import { rmRetry } from "../../../packages/core/src/paths.js";
import { FsBrowser } from "./fsBrowser.js";
import { ProjectStore } from "../../../packages/core/src/projectStore.js";
import { QueryManager } from "../../../packages/core/src/queryManager.js";
import { SessionManager } from "./session.js";
import { SnapshotStore } from "../../../packages/core/src/snapshotStore.js";
import { exportSnapshotBundle, importSnapshotBundle } from "../../../packages/core/src/snapshotBundle.js";

export interface HttpContext {
  projects: ProjectStore;
  snapshots: SnapshotStore;
  builds: BuildManager;
  queries: QueryManager;
  fs: FsBrowser;
  session: SessionManager;
  workspace: { projectRoot: string | null };
  requestExit: () => void;
  webRoot: string;
  version: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function securityHeaders(res: ServerResponse, html = false): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (html) {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "));
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown,
                  extraHeaders: Record<string, string> = {},
                  maxBytes: number = LIMITS.maxResponseBytes): void {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const err = errorResponse(new AppError("RESOURCE_LIMIT", "response exceeds the configured size limit"));
    const body = JSON.stringify(err);
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(text);
}

function ok(res: ServerResponse, data: unknown, status = 200,
            maxBytes: number = LIMITS.maxResponseBytes): void {
  sendJson(res, status, { ok: true, data }, {}, maxBytes);
}

function fail(res: ServerResponse, err: unknown): void {
  const e = asAppError(err);
  const status = (() => {
    switch (e.code) {
      case "INVALID_INPUT": return 400;
      case "PERMISSION_DENIED": return 403;
      case "UNAUTHORIZED" as never: return 401;
      case "SNAPSHOT_INCOMPLETE": return 409;
      case "SNAPSHOT_MISMATCH": return 409;
      case "SNAPSHOT_CORRUPT": return 409;
      case "SNAPSHOT_VERSION_MISMATCH": return 409;
      case "TASK_CONFLICT": return 409;
      case "STALE_CURSOR": return 409;
      case "QUERY_LIMIT": return 429;
      case "QUERY_TIMEOUT": return 504;
      case "COMPILER_ERROR": return 422;
      case "RESOURCE_LIMIT": return 413;
      case "CANCELLED": return 409;
      case "SOURCE_MISMATCH":
      case "SOURCE_UNAVAILABLE": return 410;
      case "CAPABILITY_MISSING": return 422;
      case "UNSUPPORTED_VERSION": return 400;
      default: return 500;
    }
  })();
  sendJson(res, status, errorResponse(e));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > LIMITS.maxRequestBytes) {
      throw new AppError("RESOURCE_LIMIT", "request body exceeds the configured limit");
    }
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_INPUT", "request body is not valid JSON");
  }
}

async function writeAll(handle: fsp.FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new AppError("IO_ERROR", "short write while receiving snapshot");
    offset += bytesWritten;
  }
}

async function readBinaryToFile(req: IncomingMessage, destination: string, maxBytes: number): Promise<number> {
  const handle = await fsp.open(destination, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > maxBytes) throw new AppError("RESOURCE_LIMIT", "snapshot upload exceeds the configured limit");
      await writeAll(handle, buf);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return size;
}

function sanitizeBundleFilename(raw: string | null, fallback: string): string {
  let base = (raw ?? "").normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!base) base = fallback;
  if (!/\.rtlbsnap$/i.test(base)) base += ".rtlbsnap";
  if (base.length > 180) base = `${base.slice(0, 180 - ".rtlbsnap".length)}.rtlbsnap`;
  return base;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function qstr(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  return v === null || v === "" ? null : v;
}
function qnum(url: URL, name: string): number | null {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new AppError("INVALID_INPUT", `${name} must be a non-negative integer`);
  return n;
}
function segs(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

async function serveStatic(ctx: HttpContext, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return true; }
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("\0") || rel.split("/").some((s) => s === ".." || s === ".")) return false;
  const full = path.resolve(ctx.webRoot, rel);
  if (!full.startsWith(path.resolve(ctx.webRoot) + path.sep) && full !== path.resolve(ctx.webRoot, "index.html")) return false;
  let st: fs.Stats;
  try { st = await fsp.stat(full); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Length": String(st.size),
    "Cache-Control": ext === ".html" ? "no-store" : "no-cache",
  };
  securityHeaders(res, ext === ".html");
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return true; }
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(full);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
  return true;
}

function projectIdFrom(parts: string[]): string | null {
  if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) return null;
  return parts[2];
}

function authFor(ctx: HttpContext, req: IncomingMessage, stateChanging: boolean): void {
  ctx.session.checkHost(req);
  if (stateChanging) {
    ctx.session.checkOrigin(req, true);
    ctx.session.requireCsrf(req);
  } else {
    ctx.session.requireSession(req);
  }
}

async function workspacePayload(ctx: HttpContext): Promise<Record<string, unknown>> {
  const root = ctx.workspace.projectRoot;
  const rec = ctx.projects.list().find((p) => p.projectRoot === root) ?? null;
  const snapshot: SnapshotSummary | null = rec
    ? ctx.snapshots.list(rec.projectId)[0] ?? null
    : null;
  return {
    projectRoot: root,
    project: rec ? ctx.projects.projectSummary(rec) : null,
    config: rec?.config ?? null,
    snapshot,
  };
}

async function handle(ctx: HttpContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const parts = segs(pathname);

  // Bootstrap must run before the session gate. It only accepts the launcher
  // token and sets an HttpOnly cookie; the token is removed from the URL.
  if (req.method === "GET" && pathname === "/") {
    const redirect = ctx.session.bootstrapRedirectUrl(req.url ?? "/");
    if (redirect) {
      res.writeHead(303, { Location: redirect, "Set-Cookie": ctx.session.cookieHeader(), "Cache-Control": "no-store" });
      res.end();
      return;
    }
  }

  if (pathname.startsWith("/assets/") || pathname === "/" || pathname === "/favicon.ico") {
    ctx.session.checkHost(req);
    if (await serveStatic(ctx, req, res, pathname)) return;
    if (pathname === "/") {
      securityHeaders(res, true);
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><meta charset=utf-8><title>RTL Browser</title><p>WebUI 尚未构建，请先运行 npm run build:web。</p>");
      return;
    }
  }

  if (pathname === "/api/health") {
    ctx.session.checkHost(req);
    ok(res, { status: "ok", version: ctx.version });
    return;
  }
  if (pathname === "/api/app/exit" && req.method === "POST") {
    authFor(ctx, req, true);
    res.once("finish", () => setImmediate(() => ctx.requestExit()));
    ok(res, { exiting: true });
    return;
  }
  if (pathname === "/api/session" && req.method === "GET") {
    authFor(ctx, req, false);
    ok(res, {
      csrfToken: ctx.session.csrfToken,
      version: ctx.version,
      roots: ctx.fs.roots.displayRoots,
    });
    return;
  }
  if (pathname === "/api/paths" && req.method === "GET") {
    authFor(ctx, req, false);
    const listing: FsListing = ctx.fs.list(qstr(url, "path"));
    ok(res, listing);
    return;
  }

  if (pathname === "/api/workspace" && req.method === "GET") {
    authFor(ctx, req, false);
    ok(res, await workspacePayload(ctx));
    return;
  }
  if (pathname === "/api/workspace/open" && req.method === "POST") {
    authFor(ctx, req, true);
    const body = await readJson(req) as Record<string, unknown>;
    const requested = typeof body.path === "string" ? body.path : "";
    if (!requested.trim()) throw new AppError("INVALID_INPUT", "project directory is required");
    const oldRoot = ctx.workspace.projectRoot;
    await ctx.queries.stopAll();
    const opened = await ctx.projects.openRoot(requested);
    if (oldRoot && oldRoot !== opened.projectRoot) {
      try {
        const oldRec = ctx.projects.list().find((p) => p.projectRoot === oldRoot);
        if (oldRec) {
          if (ctx.builds.activeJobId(oldRec.projectId)) await ctx.builds.cancelProject(oldRec.projectId);
          ctx.projects.close(oldRec.projectId);
        } else {
          ctx.projects.closeRoot(oldRoot);
        }
      } catch (err) {
        ctx.projects.closeRoot(opened.projectRoot);
        throw err;
      }
    }
    ctx.workspace.projectRoot = opened.projectRoot;
    ctx.fs.roots.addRoot(opened.projectRoot);
    let snapshot: SnapshotSummary | null = null;
    if (opened.project) {
      ctx.projects.recoverInterrupted(opened.project.projectId);
      snapshot = ctx.snapshots.list(opened.project.projectId)[0] ?? null;
    }
    ok(res, {
      projectRoot: opened.projectRoot,
      project: opened.project ? ctx.projects.projectSummary(opened.project) : null,
      config: opened.project?.config ?? null,
      snapshot,
    });
    return;
  }

  if (pathname === "/api/workspace/validate" && req.method === "POST") {
    authFor(ctx, req, true);
    if (!ctx.workspace.projectRoot) throw new AppError("INVALID_INPUT", "open a project directory first");
    const body = await readJson(req) as Record<string, unknown>;
    const parsed = normalizeDraft(body.config ?? body, "validate", 1, ctx.workspace.projectRoot);
    validateConfigForBuild(parsed, ctx.workspace.projectRoot);
    ok(res, {
      valid: true,
      message: "输入检查通过：必填项非空，Filelist 和路径可读；未运行编译。",
    });
    return;
  }

  if (pathname === "/api/workspace/snapshot/import" && req.method === "POST") {
    authFor(ctx, req, true);
    await handleSnapshotImport(ctx, req, res);
    return;
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    authFor(ctx, req, false);
    ok(res, ctx.projects.list().map((p) => ctx.projects.projectSummary(p)));
    return;
  }
  if (pathname === "/api/projects" && req.method === "POST") {
    authFor(ctx, req, true);
    if (!ctx.workspace.projectRoot) throw new AppError("INVALID_INPUT", "open a project directory first");
    const body = await readJson(req) as Record<string, unknown>;
    const rec = await ctx.projects.create(body.config ?? body, ctx.workspace.projectRoot);
    ok(res, { project: ctx.projects.projectSummary(rec), config: rec.config }, 201);
    return;
  }

  const pid = projectIdFrom(parts);
  if (pid) {
    if (parts.length === 3 && req.method === "GET") {
      authFor(ctx, req, false);
      const rec = ctx.projects.get(pid);
      const cur = ctx.projects.current(pid);
      ok(res, { project: ctx.projects.projectSummary(rec), config: rec.config, current: cur });
      return;
    }
    if (parts.length === 4 && parts[3] === "config" && req.method === "PUT") {
      authFor(ctx, req, true);
      const body = await readJson(req) as Record<string, unknown>;
      const expected = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      await ctx.queries.stopAll();
      const updated = ctx.projects.updateConfig(pid, body.config ?? body, expected);
      ok(res, {
        project: ctx.projects.projectSummary(updated.record),
        config: updated.record.config,
        snapshotDiscarded: updated.snapshotDiscarded,
      });
      return;
    }
    if (parts.length === 5 && parts[3] === "snapshot" && parts[4] === "discard" && req.method === "POST") {
      authFor(ctx, req, true);
      await ctx.queries.stopAll();
      const discarded = ctx.projects.discardSnapshot(pid);
      ok(res, {
        discarded: discarded.discarded,
        project: ctx.projects.projectSummary(discarded.record),
        config: discarded.record.config,
      });
      return;
    }
    if (parts.length === 4 && parts[3] === "validate" && req.method === "POST") {
      authFor(ctx, req, true);
      const rec = ctx.projects.get(pid);
      const result = ctx.projects.validate(pid);
      ok(res, {
        valid: true,
        configRevision: rec.config.configRevision,
        paths: {
          projectRoot: result.paths.projectRoot,
          workingDirectory: result.paths.workingDirectory,
          filelistPath: result.paths.filelistPath,
          sourcePaths: result.paths.sourcePaths,
          sourceRoots: result.paths.sourceRoots,
          includeRoots: result.paths.includeRoots,
          libraries: result.paths.libraries,
        },
        message: "input paths and basic structure are readable; this is not a compile check",
      });
      return;
    }
    if (parts.length === 4 && parts[3] === "build" && req.method === "POST") {
      authFor(ctx, req, true);
      const body = await readJson(req) as Record<string, unknown>;
      await ctx.queries.stopAll();
      const job = await ctx.builds.start(pid, body);
      ok(res, job, 202);
      return;
    }
    if (parts.length === 5 && parts[3] === "jobs" && req.method === "GET") {
      authFor(ctx, req, false);
      ok(res, ctx.builds.job(pid, parts[4]));
      return;
    }
    if (parts.length === 4 && parts[3] === "jobs" && req.method === "GET") {
      authFor(ctx, req, false);
      ok(res, ctx.builds.listJobs(pid));
      return;
    }
    if (parts.length === 6 && parts[3] === "jobs" && parts[5] === "cancel" && req.method === "POST") {
      authFor(ctx, req, true);
      ok(res, ctx.builds.cancel(pid, parts[4]));
      return;
    }
    if (parts.length === 6 && parts[3] === "jobs" && parts[5] === "diagnostics" && req.method === "GET") {
      authFor(ctx, req, false);
      const filter: DiagnosticsFilter = {
        severity: (qstr(url, "severity") as DiagnosticsFilter["severity"]) ?? undefined,
        stage: qstr(url, "stage") ?? undefined,
      };
      if (filter.severity && !["error", "warning", "note", "info"].includes(filter.severity)) {
        throw new AppError("INVALID_INPUT", "invalid severity filter");
      }
      ok(res, ctx.builds.diagnosticsPage(pid, parts[4], filter, qstr(url, "cursor"), qnum(url, "limit")));
      return;
    }
    if (parts.length === 4 && parts[3] === "events" && req.method === "GET") {
      authFor(ctx, req, false);
      openEvents(ctx, req, res, pid);
      return;
    }
    if (parts.length === 4 && parts[3] === "snapshots" && req.method === "GET") {
      authFor(ctx, req, false);
      ok(res, ctx.snapshots.list(pid));
      return;
    }
    if (parts.length >= 6 && parts[3] === "snapshots") {
      authFor(ctx, req, false);
      const sid = parts[4];
      const rest = parts.slice(5).join("/");
      await handleSnapshot(ctx, req, res, url, pid, sid, rest);
      return;
    }
    throw new AppError("INVALID_INPUT", "unknown API route");
  }

  if (pathname.startsWith("/api/")) throw new AppError("INVALID_INPUT", "unknown API route");
  securityHeaders(res, true);
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

async function handleExport(
  ctx: HttpContext,
  res: ServerResponse,
  url: URL,
  projectId: string,
  snapshotId: string,
): Promise<void> {
  const manifest = ctx.snapshots.manifest(projectId, snapshotId);
  const rec = ctx.projects.get(projectId);
  const fallback = `${manifest.topModule || "snapshot"}.rtlbsnap`;
  const filename = sanitizeBundleFilename(qstr(url, "filename"), sanitizeBundleFilename(fallback, "snapshot.rtlbsnap"));
  const tmpRoot = await ctx.projects.sessionTmpDir(rec.projectRoot);
  const workDir = await fsp.mkdtemp(path.join(tmpRoot, "export-"));
  const outputFile = path.join(workDir, `${crypto.randomBytes(8).toString("hex")}.rtlbsnap`);
  try {
    await exportSnapshotBundle({
      snapshotDir: ctx.snapshots.snapshotPath(projectId, snapshotId),
      manifest,
      config: rec.config,
      outputFile,
      programVersion: ctx.version,
    });
    const st = await fsp.stat(outputFile);
    res.writeHead(200, {
      "Content-Type": "application/vnd.rtlb.snapshot",
      "Content-Length": String(st.size),
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(fs.createReadStream(outputFile), res);
  } finally {
    await rmRetry(workDir).catch(() => undefined);
  }
}

async function handleSnapshotImport(
  ctx: HttpContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const root = ctx.workspace.projectRoot;
  if (!root) throw new AppError("INVALID_INPUT", "open a project directory first");
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/octet-stream") {
    throw new AppError("INVALID_INPUT", "snapshot import requires application/octet-stream");
  }
  const declared = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > LIMITS.maxSnapshotBundleBytes) {
    throw new AppError("RESOURCE_LIMIT", "snapshot upload exceeds the configured limit");
  }
  const opened = await ctx.projects.openRoot(root);
  if (opened.project?.activeJobId) {
    throw new AppError("TASK_CONFLICT", "cancel the active build before importing a snapshot");
  }
  const workDir = await fsp.mkdtemp(path.join(opened.stateDir, "tmp", "import-"));
  try {
    const uploadFile = path.join(workDir, "upload.rtlbsnap");
    await readBinaryToFile(req, uploadFile, LIMITS.maxSnapshotBundleBytes);
    const stagingDir = path.join(workDir, "snapshot");
    const imported = await importSnapshotBundle(uploadFile, stagingDir);
    let rec = opened.project;
    if (!rec) rec = await ctx.projects.adoptImportedProject(opened.projectRoot, imported.config);
    await ctx.queries.stopAll();
    const installed = await ctx.snapshots.installImported(rec.projectId, stagingDir, imported.manifest, imported.config);
    ctx.workspace.projectRoot = opened.projectRoot;
    ctx.fs.roots.addRoot(opened.projectRoot);
    ok(res, {
      project: ctx.projects.projectSummary(rec),
      config: rec.config,
      snapshot: {
        snapshotId: installed.manifest.snapshotId,
        projectId: rec.projectId,
        rootPath: installed.manifest.rootPath,
        topModule: installed.manifest.topModule,
        compilerVersion: installed.manifest.compilerVersion,
        createdAt: installed.manifest.createdAt,
        counts: installed.manifest.counts,
        capabilities: installed.manifest.capabilities,
      },
    });
  } finally {
    await rmRetry(workDir).catch(() => undefined);
  }
}

async function handleSnapshot(
  ctx: HttpContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  projectId: string,
  snapshotId: string,
  rest: string,
): Promise<void> {
  if (req.method !== "GET") throw new AppError("INVALID_INPUT", "snapshot queries are read-only");
  if (rest === "export") {
    await handleExport(ctx, res, url, projectId, snapshotId);
    return;
  }
  const manifest = ctx.snapshots.manifest(projectId, snapshotId);
  const q = (method: string, params: Record<string, unknown>) => ctx.queries.call(projectId, snapshotId, method, params);
  switch (rest) {
    case "info":
      ok(res, manifest);
      return;
    case "hierarchy/children":
      ok(res, await q("hierarchy.children", {
        parentId: qstr(url, "parentId"),
        cursor: qstr(url, "cursor"),
        limit: qnum(url, "limit"),
      }));
      return;
    case "hierarchy/ancestors":
      ok(res, await q("hierarchy.ancestors", { instanceId: qstr(url, "instanceId") }));
      return;
    case "hierarchy/search":
      ok(res, await q("hierarchy.search", { query: qstr(url, "q"), limit: qnum(url, "limit") }));
      return;
    case "source":
      ok(res, await q("source.window", {
        sourceId: qstr(url, "sourceId"),
        instanceId: qstr(url, "instanceId"),
        line: qnum(url, "line"),
        startLine: qnum(url, "startLine"),
        contextLines: qnum(url, "contextLines"),
        byteOffset: qnum(url, "byteOffset"),
        scopeByte: qnum(url, "scopeByte"),
        maxBytes: qnum(url, "maxBytes"),
      }), 200, LIMITS.maxSourceResponseBytes);
      return;
    case "definition":
      ok(res, await q("symbol.definition", { symbolId: qstr(url, "symbolId") }));
      return;
    case "resolve":
      ok(res, await q("resolve", {
        sourceId: qstr(url, "sourceId"),
        instanceId: qstr(url, "instanceId"),
        byteOffset: qnum(url, "byteOffset"),
      }));
      return;
    case "hover":
      ok(res, await q("hover", {
        occurrenceId: qstr(url, "occurrenceId"),
        sourceId: qstr(url, "sourceId"),
        instanceId: qstr(url, "instanceId"),
        byteOffset: qnum(url, "byteOffset"),
      }));
      return;
    case "drivers":
      ok(res, await q("drivers.list", {
        instanceId: qstr(url, "instanceId"),
        symbolId: qstr(url, "symbolId"),
        bitSelection: qstr(url, "bitSelection"),
        cursor: qstr(url, "cursor"),
        limit: qnum(url, "limit"),
      }));
      return;
    case "loads": {
      const roles = (qstr(url, "roles") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      ok(res, await q("loads.list", {
        instanceId: qstr(url, "instanceId"),
        symbolId: qstr(url, "symbolId"),
        bitSelection: qstr(url, "bitSelection"),
        roles,
        cursor: qstr(url, "cursor"),
        limit: qnum(url, "limit"),
      }));
      return;
    }
    case "inspector":
      ok(res, await q("inspector.page", {
        instanceId: qstr(url, "instanceId"),
        tab: qstr(url, "tab"),
        cursor: qstr(url, "cursor"),
        limit: qnum(url, "limit"),
      }));
      return;
    default:
      throw new AppError("INVALID_INPUT", "unknown snapshot route");
  }
}

function openEvents(ctx: HttpContext, req: IncomingMessage, res: ServerResponse, projectId: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const onBuild = (ev: BuildEvent) => {
    if (ev.projectId !== projectId) return;
    try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ }
  };
  ctx.builds.on("build", onBuild);
  const keep = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
  }, 15000);
  keep.unref?.();
  req.on("close", () => {
    clearInterval(keep);
    ctx.builds.off("build", onBuild);
  });
}

export function createHttpServer(ctx: HttpContext) {
  const server = http.createServer((req, res) => {
    void handle(ctx, req, res).catch((err) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      try { fail(res, err); } catch { try { res.end(); } catch { /* ignore */ } }
    });
  });
  // Snapshot uploads can legitimately take minutes; JSON endpoints keep
  // their own 65 KiB body cap and are parsed immediately.
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 15_000;
  return server;
}
