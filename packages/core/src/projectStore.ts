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
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../contracts/src/errors.js";
import {
  EXTRACTOR_VERSION,
  PROTOCOL_VERSION,
  PROJECT_FORMAT_VERSION,
  type BuildConfig,
  type ProjectSummary,
} from "../../contracts/src/types.js";
import { validateBuildConfig } from "../../contracts/src/validation.js";
import { atomicWriteJson, ensureDir, isWithin, normalizeNativePath, parseJsonFile, rmSyncRetry } from "./paths.js";
import {
  STATE_DIR_NAME,
  buildConfigDigest,
  normalizeDraft,
  validateConfigForBuild,
  validateConfigPaths,
} from "./config.js";

export interface ProjectRecord {
  projectId: string;
  name: string;
  projectRoot: string;
  formatVersion: number;
  extractorVersion: string;
  config: BuildConfig;
  activeJobId: string | null;
  currentSnapshotId: string | null;
  lastBuildDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurrentPointer {
  projectId: string;
  snapshotId: string;
  manifestSha256: string;
  publishedAt: string;
}

export interface JobDisk {
  jobId: string;
  projectId: string;
  requestKey: string;
  configRevision: number;
  configDigest: string;
  state: string;
  stage: string;
  compileStatus: "unknown" | "succeeded" | "failed";
  snapshotStatus: "none" | "building" | "complete" | "failed";
  snapshotId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  counts: Record<string, number>;
  diagnostics: { error: number; warning: number; note: number; info: number; truncated: boolean };
}

export interface OpenRootResult {
  projectRoot: string;
  stateDir: string;
  project: ProjectRecord | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function validChildName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    value !== "." && value !== ".." && !value.startsWith(".");
}

export class ProjectStore {
  private readonly records = new Map<string, ProjectRecord>();
  private readonly roots = new Map<string, string>();
  // projectRoot -> per-process session directory
  private readonly openDirs = new Map<string, string>();
  private readonly sessionDirs = new Map<string, string>();
  private readonly touchedRoots = new Set<string>();

  constructor(private readonly sessionId: string = crypto.randomUUID()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(sessionId)) {
      throw new AppError("INVALID_INPUT", "invalid session id");
    }
  }

  private stateDir(projectId: string): string {
    const dir = this.openDirs.get(this.records.get(projectId)?.projectRoot ?? "");
    if (!dir) throw new AppError("INVALID_INPUT", "project is not open");
    return dir;
  }

  async openRoot(rawRoot: string): Promise<OpenRootResult> {
    const root = realDirectory(rawRoot);
    const existingDir = this.openDirs.get(root);
    if (existingDir) {
      const id = this.roots.get(root);
      return { projectRoot: root, stateDir: existingDir, project: id ? this.records.get(id) ?? null : null };
    }
    const stateRoot = prepareStateDir(root);
    pruneStaleSessions(stateRoot, this.sessionId);
    const sessionDir = prepareSessionDir(stateRoot, this.sessionId, root);
    this.openDirs.set(root, sessionDir);
    this.sessionDirs.set(root, sessionDir);
    this.touchedRoots.add(root);
    const projectFile = path.join(sessionDir, "project.json");
    let project: ProjectRecord | null = null;
    if (fs.existsSync(projectFile)) {
      try {
        const parsed = parseJsonFile<ProjectRecord>(projectFile);
        if (!parsed || typeof parsed.projectId !== "string" || parsed.projectRoot !== root) {
          throw new Error("invalid session project");
        }
        project = parsed;
      } catch {
        // Session-only state is disposable; discard a corrupt session rather
        // than blocking the user with a cross-process reset flow.
        rmSyncRetry(sessionDir, { recursive: true, force: true });
        prepareSessionDir(stateRoot, this.sessionId, root);
      }
    }
    if (project) {
      this.records.set(project.projectId, project);
      this.roots.set(root, project.projectId);
      this.cleanupTransient(project.projectId);
    }
    return { projectRoot: root, stateDir: sessionDir, project };
  }

  closeRoot(rawRoot: string): void {
    let root = path.resolve(rawRoot);
    try { root = normalizeNativePath(fs.realpathSync.native(root)); } catch { /* use resolved path */ }
    const id = this.roots.get(root);
    if (id) this.records.delete(id);
    this.roots.delete(root);
    this.openDirs.delete(root);
    // Keep the session directory: reopening the same root within this server
    // process resumes this session. It is removed on graceful shutdown.
  }

  close(projectId: string): void {
    const rec = this.records.get(projectId);
    if (!rec) return;
    this.closeRoot(rec.projectRoot);
  }

  closeAll(): void {
    for (const root of [...this.openDirs.keys()]) this.closeRoot(root);
  }

  /** Remove only this process's session directories; never touch sibling sessions. */
  purgeSessionState(): void {
    for (const root of [...this.touchedRoots]) {
      const sessionDir = this.sessionDirs.get(root);
      if (!sessionDir) continue;
      try { rmSyncRetry(sessionDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmdirSync(path.dirname(sessionDir)); } catch { /* other sessions remain */ }
    }
    this.touchedRoots.clear();
  }

  projectDir(projectId: string): string {
    return this.stateDir(projectId);
  }

  jobDir(projectId: string, jobId: string): string {
    if (!validChildName(jobId)) throw new AppError("INVALID_INPUT", "invalid job id");
    return path.join(this.projectDir(projectId), "jobs", jobId);
  }

  snapshotDir(projectId: string, snapshotId: string): string {
    if (!validChildName(snapshotId)) throw new AppError("INVALID_INPUT", "invalid snapshot id");
    return path.join(this.projectDir(projectId), "snapshots", snapshotId);
  }

  currentPath(projectId: string): string {
    return path.join(this.projectDir(projectId), "current.json");
  }

  async ensureLayout(projectId: string): Promise<void> {
    const dir = this.projectDir(projectId);
    await ensureDir(path.join(dir, "jobs"));
    await ensureDir(path.join(dir, "snapshots"));
    await ensureDir(path.join(dir, "tmp"));
  }

  async create(draft: unknown, projectRoot: string): Promise<ProjectRecord> {
    const opened = await this.openRoot(projectRoot);
    if (opened.project) throw new AppError("TASK_CONFLICT", "project already exists for this directory");
    const projectId = crypto.randomUUID();
    const now = isoNow();
    const parsed = normalizeDraft(draft, projectId, 1, opened.projectRoot);
    const config = validateConfigForBuild(parsed, opened.projectRoot);
    const record: ProjectRecord = {
      projectId,
      name: config.name,
      projectRoot: opened.projectRoot,
      formatVersion: PROJECT_FORMAT_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      config,
      activeJobId: null,
      currentSnapshotId: null,
      lastBuildDigest: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(projectId, record);
    this.roots.set(opened.projectRoot, projectId);
    try {
      await this.ensureLayout(projectId);
      await atomicWriteJson(path.join(opened.stateDir, "project.json"), record);
    } catch (err) {
      this.records.delete(projectId);
      this.roots.delete(opened.projectRoot);
      throw err;
    }
    return record;
  }

  /**
   * Create a project record from an imported snapshot when the directory has
   * no saved configuration. The imported paths are kept verbatim (they may
   * point at another machine) and are not build-validated.
   */
  async adoptImportedProject(projectRoot: string, imported: BuildConfig): Promise<ProjectRecord> {
    const opened = await this.openRoot(projectRoot);
    if (opened.project) return opened.project;
    const projectId = crypto.randomUUID();
    const now = isoNow();
    const base: Omit<BuildConfig, "configDigest"> = {
      ...imported,
      protocolVersion: PROTOCOL_VERSION,
      projectId,
      name: path.basename(opened.projectRoot),
      projectRoot: opened.projectRoot,
      workingDirectory: opened.projectRoot,
      configRevision: 1,
    };
    const config = validateBuildConfig({ ...base, configDigest: buildConfigDigest(base) });
    const record: ProjectRecord = {
      projectId,
      name: config.name,
      projectRoot: opened.projectRoot,
      formatVersion: PROJECT_FORMAT_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      config,
      activeJobId: null,
      currentSnapshotId: null,
      lastBuildDigest: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(projectId, record);
    this.roots.set(opened.projectRoot, projectId);
    try {
      await this.ensureLayout(projectId);
      await atomicWriteJson(path.join(opened.stateDir, "project.json"), record);
    } catch (err) {
      this.records.delete(projectId);
      this.roots.delete(opened.projectRoot);
      throw err;
    }
    return record;
  }

  /** Session-scoped scratch directory; removed on graceful shutdown. */
  async sessionTmpDir(projectRoot: string): Promise<string> {
    const opened = await this.openRoot(projectRoot);
    const dir = path.join(opened.stateDir, "tmp");
    await ensureDir(dir);
    return dir;
  }

  get(projectId: string): ProjectRecord {
    const rec = this.records.get(projectId);
    if (!rec) throw new AppError("INVALID_INPUT", "project is not open");
    return rec;
  }

  list(): ProjectRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateConfig(projectId: string, draft: unknown, expectedRevision?: number): {
    record: ProjectRecord;
    snapshotDiscarded: boolean;
  } {
    const rec = this.get(projectId);
    if (expectedRevision !== undefined && rec.config.configRevision !== expectedRevision) {
      throw new AppError("TASK_CONFLICT", "configuration revision changed; refresh before saving");
    }
    const revision = rec.config.configRevision + 1;
    const parsed = normalizeDraft(draft, projectId, revision, rec.projectRoot);
    const config = validateConfigForBuild(parsed, rec.projectRoot);
    const changed = config.configDigest !== rec.config.configDigest;
    if (changed && rec.activeJobId) {
      throw new AppError("TASK_CONFLICT", "cancel the active build before changing configuration");
    }
    let snapshotDiscarded = false;
    if (changed) {
      snapshotDiscarded = this.hasSnapshotArtifacts(projectId);
      // A build configuration change invalidates every artifact produced from
      // the previous configuration. Do not keep a snapshot around for reuse.
      this.purgeBuildState(projectId);
    }
    const next: ProjectRecord = {
      ...this.get(projectId),
      name: config.name,
      config,
      updatedAt: isoNow(),
    };
    this.records.set(projectId, next);
    this.writeProject(next);
    return { record: next, snapshotDiscarded };
  }

  clearCurrentSnapshot(projectId: string): void {
    const rec = this.get(projectId);
    rmSyncRetry(this.currentPath(projectId), { force: true });
    const next = { ...rec, currentSnapshotId: null, updatedAt: isoNow() };
    this.records.set(projectId, next);
    this.writeProject(next);
  }

  discardSnapshot(projectId: string): { record: ProjectRecord; discarded: boolean } {
    const rec = this.get(projectId);
    if (rec.activeJobId) {
      throw new AppError("TASK_CONFLICT", "cancel the active build before deleting the snapshot");
    }
    const discarded = this.hasSnapshotArtifacts(projectId);
    this.purgeBuildState(projectId);
    return { record: this.get(projectId), discarded };
  }

  private hasSnapshotArtifacts(projectId: string): boolean {
    if (fs.existsSync(this.currentPath(projectId))) return true;
    const dir = path.join(this.projectDir(projectId), "snapshots");
    try {
      return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  }

  validate(projectId: string): { ok: true; paths: ReturnType<typeof validateConfigPaths>; config: BuildConfig } {
    const rec = this.get(projectId);
    const paths = validateConfigPaths(rec.config, rec.projectRoot);
    return { ok: true, paths, config: rec.config };
  }

  setActiveJob(projectId: string, jobId: string | null): ProjectRecord {
    const rec = this.get(projectId);
    const next = { ...rec, activeJobId: jobId, updatedAt: isoNow() };
    this.records.set(projectId, next);
    this.writeProject(next);
    return next;
  }

  setCurrentSnapshot(projectId: string, snapshotId: string, manifestSha256: string): CurrentPointer {
    const pointer: CurrentPointer = {
      projectId,
      snapshotId,
      manifestSha256,
      publishedAt: isoNow(),
    };
    const rec = this.get(projectId);
    const next = { ...rec, currentSnapshotId: snapshotId, updatedAt: isoNow() };
    this.records.set(projectId, next);
    this.writeProject(next);
    atomicWriteJsonSync(this.currentPath(projectId), pointer);
    return pointer;
  }

  setLastBuildDigest(projectId: string, digest: string): ProjectRecord {
    const rec = this.get(projectId);
    const next = { ...rec, lastBuildDigest: digest, updatedAt: isoNow() };
    this.records.set(projectId, next);
    this.writeProject(next);
    return next;
  }

  /** Purge old build artifacts when the project input changes. */
  purgeBuildState(projectId: string): void {
    const rec = this.get(projectId);
    const dir = this.projectDir(projectId);
    rmSyncRetry(path.join(dir, "jobs"), { recursive: true, force: true });
    rmSyncRetry(path.join(dir, "snapshots"), { recursive: true, force: true });
    rmSyncRetry(this.currentPath(projectId), { force: true });
    fs.mkdirSync(path.join(dir, "jobs"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true, mode: 0o700 });
    const next = { ...rec, currentSnapshotId: null, activeJobId: null, lastBuildDigest: null, updatedAt: isoNow() };
    this.records.set(projectId, next);
    this.writeProject(next);
  }

  pruneSnapshots(projectId: string, keep: string): void {
    const dir = path.join(this.projectDir(projectId), "snapshots");
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name === keep) continue;
      if (!validChildName(name)) continue;
      rmSyncRetry(path.join(dir, name), { recursive: true, force: true });
    }
  }

  prepareBuild(projectId: string, digest: string): { purged: boolean } {
    const rec = this.get(projectId);
    // Only one snapshot version is kept per project.
    if (rec.currentSnapshotId) this.pruneSnapshots(projectId, rec.currentSnapshotId);
    const dir = this.projectDir(projectId);
    const jobsDir = path.join(dir, "jobs");
    const snapshotsDir = path.join(dir, "snapshots");
    const hasResidual = fs.existsSync(this.currentPath(projectId)) ||
      (fs.existsSync(snapshotsDir) && fs.readdirSync(snapshotsDir).length > 0) ||
      (fs.existsSync(jobsDir) && fs.readdirSync(jobsDir).length > 0);
    const changed = rec.lastBuildDigest !== null && rec.lastBuildDigest !== digest;
    if (changed || (rec.lastBuildDigest === null && hasResidual)) {
      this.purgeBuildState(projectId);
      this.setLastBuildDigest(projectId, digest);
      return { purged: true };
    }
    this.setLastBuildDigest(projectId, digest);
    return { purged: false };
  }

  recoverInterrupted(projectId: string): void {
    for (const job of this.listJobs(projectId)) {
      if (["COMPLETE", "FAILED", "CANCELLED"].includes(job.state)) continue;
      job.state = "FAILED";
      job.stage = "INTERRUPTED";
      job.compileStatus = "failed";
      job.snapshotStatus = "failed";
      job.finishedAt = isoNow();
      job.error = { code: "INTERNAL_ERROR", message: "server restarted while this job was active", retryable: true };
      atomicWriteJsonSync(path.join(this.jobDir(projectId, job.jobId), "job.json"), job);
    }
    const rec = this.get(projectId);
    if (rec.activeJobId) this.setActiveJob(projectId, null);
  }

  cleanupTransient(projectId: string): void {
    const dir = this.projectDir(projectId);
    rmSyncRetry(path.join(dir, "tmp"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "tmp"), { recursive: true, mode: 0o700 });
    const jobs = path.join(dir, "jobs");
    if (!fs.existsSync(jobs)) return;
    for (const name of fs.readdirSync(jobs)) {
      const jobDir = path.join(jobs, name);
      const candidate = path.join(jobDir, "candidate");
      if (fs.existsSync(candidate)) rmSyncRetry(candidate, { recursive: true, force: true });
      if (fs.existsSync(jobDir)) {
        for (const entry of fs.readdirSync(jobDir)) {
          if (entry.startsWith("normalized-") && entry.endsWith(".f")) rmSyncRetry(path.join(jobDir, entry), { force: true });
        }
      }
    }
  }

  current(projectId: string): CurrentPointer | null {
    const file = this.currentPath(projectId);
    if (!fs.existsSync(file)) return null;
    try {
      return parseJsonFile<CurrentPointer>(file);
    } catch {
      return null;
    }
  }

  projectSummary(rec: ProjectRecord): ProjectSummary {
    const cur = this.current(rec.projectId);
    return {
      projectId: rec.projectId,
      name: rec.name,
      projectRoot: rec.projectRoot,
      configRevision: rec.config.configRevision,
      currentSnapshotId: cur?.snapshotId ?? rec.currentSnapshotId,
      currentSnapshotPath: cur ? `snapshots/${cur.snapshotId}` : null,
      activeJobId: rec.activeJobId,
      updatedAt: rec.updatedAt,
    };
  }

  async writeJob(job: JobDisk): Promise<void> {
    const dir = this.jobDir(job.projectId, job.jobId);
    await ensureDir(dir);
    await atomicWriteJson(path.join(dir, "job.json"), job);
  }

  readJob(projectId: string, jobId: string): JobDisk {
    return parseJsonFile<JobDisk>(path.join(this.jobDir(projectId, jobId), "job.json"));
  }

  listJobs(projectId: string): JobDisk[] {
    const dir = path.join(this.projectDir(projectId), "jobs");
    if (!fs.existsSync(dir)) return [];
    const out: JobDisk[] = [];
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name, "job.json");
      if (!fs.existsSync(f)) continue;
      try { out.push(parseJsonFile<JobDisk>(f)); } catch { /* ignore */ }
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  }

  appendDiagnostic(projectId: string, jobId: string, diag: unknown): void {
    const dir = this.jobDir(projectId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "diagnostics.ndjson"), JSON.stringify(diag) + "\n", { mode: 0o600 });
  }

  readDiagnostics(projectId: string, jobId: string): unknown[] {
    const file = path.join(this.jobDir(projectId, jobId), "diagnostics.ndjson");
    if (!fs.existsSync(file)) return [];
    const out: unknown[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* ignore torn tail */ }
    }
    return out;
  }

  appendWorkerLog(projectId: string, jobId: string, chunk: string): void {
    const dir = this.jobDir(projectId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "worker.stderr.log");
    fs.appendFileSync(file, chunk, { mode: 0o600 });
    const st = fs.statSync(file);
    if (st.size > 2_097_152) {
      const buf = fs.readFileSync(file);
      fs.writeFileSync(file, buf.subarray(buf.length - 2_097_152), { mode: 0o600 });
    }
  }

  jobFilePath(projectId: string, jobId: string, name: string): string {
    const dir = this.jobDir(projectId, jobId);
    const p = path.join(dir, name);
    if (!isWithin(dir, p)) throw new AppError("INVALID_INPUT", "job file path escape");
    return p;
  }

  private writeProject(rec: ProjectRecord): void {
    atomicWriteJsonSync(path.join(this.projectDir(rec.projectId), "project.json"), rec);
  }
}

function atomicWriteJsonSync(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function realDirectory(rawRoot: string): string {
  let root: string;
  try {
    root = normalizeNativePath(fs.realpathSync.native(path.resolve(rawRoot)));
  } catch {
    throw new AppError("INVALID_INPUT", "projectRoot does not exist or is not accessible");
  }
  const st = fs.statSync(root);
  if (!st.isDirectory()) throw new AppError("INVALID_INPUT", "projectRoot is not a directory");
  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new AppError("PERMISSION_DENIED", "projectRoot is not readable and writable");
  }
  return root;
}

function prepareStateDir(root: string): string {
  const logical = path.join(root, STATE_DIR_NAME);
  let stateDir = logical;
  try {
    fs.lstatSync(logical);
    stateDir = normalizeNativePath(fs.realpathSync.native(logical));
    if (!isWithin(root, stateDir) || stateDir === root) {
      throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME} escapes the project root`);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Missing state directory is created below.
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // A Windows junction is reported as a directory by lstat; resolve it again
    // before the first write so it cannot redirect state outside the project.
    stateDir = normalizeNativePath(fs.realpathSync.native(stateDir));
    if (!isWithin(root, stateDir) || stateDir === root) {
      throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME} escapes the project root`);
    }
    fs.accessSync(stateDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    const probe = path.join(stateDir, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(probe, "ok", { mode: 0o600, flag: "wx" });
    fs.unlinkSync(probe);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME} is not writable`);
  }
  return stateDir;
}

function sessionMetadataPath(sessionDir: string): string {
  return path.join(sessionDir, "session.json");
}

function prepareSessionDir(stateRoot: string, sessionId: string, projectRoot: string): string {
  const sessions = path.join(stateRoot, "sessions");
  try {
    const st = fs.lstatSync(sessions);
    if (st.isSymbolicLink()) throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME}/sessions must not be a symbolic link`);
  } catch (err) {
    if (err instanceof AppError) throw err;
  }
  try {
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    fs.accessSync(sessions, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME}/sessions is not writable`);
  }
  const sessionsReal = normalizeNativePath(fs.realpathSync.native(sessions));
  if (!isWithin(stateRoot, sessionsReal) || sessionsReal === stateRoot) {
    throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME}/sessions escapes the project root`);
  }
  const dir = path.join(sessionsReal, sessionId);
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) throw new AppError("PERMISSION_DENIED", "session directory must not be a symbolic link");
  } catch (err) {
    if (err instanceof AppError) throw err;
  }
  let real: string;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Resolve before writing metadata, so a junction named like a session
    // cannot redirect writes outside the project.
    real = normalizeNativePath(fs.realpathSync.native(dir));
    if (!isWithin(sessionsReal, real) || real === sessionsReal) {
      throw new AppError("PERMISSION_DENIED", "session directory escapes the project root");
    }
    fs.chmodSync(real, 0o700);
    for (const child of ["jobs", "snapshots", "tmp"]) {
      fs.mkdirSync(path.join(real, child), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(real, child), 0o700);
    }
    atomicWriteJsonSync(sessionMetadataPath(real), {
      sessionFormatVersion: 1,
      sessionId,
      pid: process.pid,
      hostname: os.hostname(),
      projectRoot,
      startedAt: isoNow(),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("PERMISSION_DENIED", `${STATE_DIR_NAME}/sessions is not writable`);
  }
  return real;
}

function pruneStaleSessions(stateRoot: string, currentSessionId: string): void {
  const sessions = path.join(stateRoot, "sessions");
  let names: string[];
  try { names = fs.readdirSync(sessions); } catch { return; }
  for (const name of names) {
    if (name === currentSessionId) continue;
    const dir = path.join(sessions, name);
    try {
      const lst = fs.lstatSync(dir);
      if (!lst.isDirectory() || lst.isSymbolicLink()) continue;
      const realDir = normalizeNativePath(fs.realpathSync.native(dir));
      if (!isWithin(stateRoot, realDir) || realDir === stateRoot) continue;
      const st = fs.statSync(realDir);
      let pid: number | null = null;
      let valid = false;
      try {
        const meta = JSON.parse(fs.readFileSync(sessionMetadataPath(realDir), "utf8")) as { pid?: unknown };
        if (typeof meta.pid === "number" && Number.isSafeInteger(meta.pid) && meta.pid > 0) {
          pid = meta.pid;
          valid = true;
        }
      } catch { /* malformed metadata */ }
      if (valid && pid !== null) {
        try {
          process.kill(pid, 0);
          continue; // another live server owns this session
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") continue;
        }
        rmSyncRetry(realDir);
      } else if (Date.now() - st.mtimeMs > 60_000) {
        // Malformed metadata is only removed after a grace period so a session
        // that is still being initialized by another process is not deleted.
        rmSyncRetry(realDir);
      }
    } catch { /* cleanup is best effort */ }
  }
}

export async function loadProjectConfigForBuild(store: ProjectStore, projectId: string): Promise<{ rec: ProjectRecord; config: BuildConfig }> {
  const rec = store.get(projectId);
  const config = validateConfigForBuild(rec.config, rec.projectRoot);
  return { rec, config };
}
