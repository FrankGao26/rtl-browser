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
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AppError } from "../../contracts/src/errors.js";
import { LIMITS } from "../../contracts/src/limits.js";
import type {
  BuildJobSummary,
  BuildState,
  BuildDiagnostic,
  Capability,
} from "../../contracts/src/types.js";
import { PROTOCOL_VERSION, REQUIRED_CAPABILITIES } from "../../contracts/src/types.js";
import { validateWorkerMessage } from "../../contracts/src/validation.js";
import { atomicWriteJson, ensureDir, isWithin, safeChild } from "./paths.js";
import { projectInputDigest } from "./config.js";
import { ProjectStore, type JobDisk } from "./projectStore.js";
import { SnapshotStore } from "./snapshotStore.js";

interface WorkerArtifact {
  manifestPath: string;
  manifestSha256: string;
  snapshotId: string;
  counts: Record<string, number>;
  capabilities: Record<string, { present: boolean; complete: boolean; reason: string | null }>;
}

interface ActiveBuild {
  projectId: string;
  job: JobDisk;
  child: ChildProcess;
  cancelRequested: boolean;
  artifact: WorkerArtifact | null;
  workerError: { code: string; message: string; retryable: boolean } | null;
  finished: boolean;
  killTimer: NodeJS.Timeout | null;
}

export interface BuildEvent {
  type: "job" | "diagnostic" | "stage" | "done";
  projectId: string;
  jobId: string;
  data: unknown;
}

export interface DiagnosticsFilter {
  severity?: "error" | "warning" | "note" | "info";
  stage?: string;
}

function now(): string { return new Date().toISOString(); }

function baseSummary(job: JobDisk): BuildJobSummary {
  return {
    jobId: job.jobId,
    projectId: job.projectId,
    requestKey: job.requestKey,
    configRevision: job.configRevision,
    state: job.state as BuildState,
    compileStatus: job.compileStatus,
    snapshotStatus: job.snapshotStatus,
    snapshotId: job.snapshotId,
    stage: job.stage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    counts: job.counts,
    diagnostics: job.diagnostics,
  };
}

function encodeDiagnosticCursor(jobId: string, filter: DiagnosticsFilter, after: number): string {
  return Buffer.from(JSON.stringify({ v: 1, jobId, severity: filter.severity ?? null, stage: filter.stage ?? null, after }), "utf8").toString("base64url");
}
function decodeDiagnosticCursor(jobId: string, filter: DiagnosticsFilter, raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return -1;
  try {
    const c = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8")) as Record<string, unknown>;
    if (c.v !== 1 || c.jobId !== jobId || (c.severity ?? null) !== (filter.severity ?? null) || (c.stage ?? null) !== (filter.stage ?? null)) {
      throw new Error("mismatch");
    }
    return Number(c.after);
  } catch {
    throw new AppError("STALE_CURSOR", "diagnostic cursor is invalid");
  }
}

export class BuildManager extends EventEmitter {
  readonly projects: ProjectStore;
  readonly snapshots: SnapshotStore;
  readonly workerPath: string;
  readonly schemaPath: string;
  private active = new Map<string, ActiveBuild>();
  private closing = false;

  constructor(projects: ProjectStore, snapshots: SnapshotStore, workerPath: string, schemaPath: string) {
    super();
    this.projects = projects;
    this.snapshots = snapshots;
    this.workerPath = workerPath;
    this.schemaPath = schemaPath;
  }

  private emitBuild(type: BuildEvent["type"], job: JobDisk, data: unknown): void {
    this.emit("build", { type, projectId: job.projectId, jobId: job.jobId, data } satisfies BuildEvent);
  }

  private updateChain: Promise<void> = Promise.resolve();

  private update(job: JobDisk, patch: Partial<JobDisk>, event: BuildEvent["type"] = "job"): Promise<void> {
    // Worker stdout events and the exit handler both write job.json. Serialize
    // writes and refuse late stage/progress messages so a terminal state can
    // never be overwritten by an in-flight message.
    const run = this.updateChain.then(async () => {
      if (job.state === "COMPLETE" || job.state === "FAILED" || job.state === "CANCELLED") return;
      Object.assign(job, patch);
      await this.projects.writeJob(job);
      this.emitBuild(event, job, baseSummary(job));
    });
    this.updateChain = run.catch(() => {});
    return run;
  }

  activeJobId(projectId: string): string | null {
    return this.active.get(projectId)?.job.jobId ?? null;
  }

  async start(projectId: string, body: Record<string, unknown>): Promise<BuildJobSummary> {
    if (this.closing) throw new AppError("RESOURCE_LIMIT", "server is shutting down");
    const rec = this.projects.get(projectId);
    const requestedRevision = typeof body.configRevision === "number" ? body.configRevision : undefined;
    if (requestedRevision !== undefined && requestedRevision !== rec.config.configRevision) {
      throw new AppError("TASK_CONFLICT", "configuration revision changed; save and retry");
    }
    const requestKey = typeof body.requestKey === "string" && body.requestKey.length > 0 && body.requestKey.length <= 256
      ? body.requestKey
      : crypto.randomUUID();
    const active = this.active.get(projectId);
    if (active) {
      if (active.job.requestKey === requestKey) return baseSummary(active.job);
      throw new AppError("TASK_CONFLICT", `a build is already active: ${active.job.jobId}`);
    }
    // Idempotent retry of a completed request.
    for (const prior of this.projects.listJobs(projectId)) {
      if (prior.requestKey === requestKey && prior.configRevision === rec.config.configRevision && prior.configDigest === rec.config.configDigest) {
        if (prior.state === "COMPLETE" || prior.state === "FAILED" || prior.state === "CANCELLED") return baseSummary(prior);
        throw new AppError("TASK_CONFLICT", `request is already known as job ${prior.jobId}`);
      }
    }
    if (!fs.existsSync(this.workerPath)) {
      throw new AppError("COMPILER_ERROR", "native index-worker is not built", { retryable: false });
    }
    const prepared = this.projects.prepareBuild(projectId, projectInputDigest(rec.config));
    const jobId = crypto.randomUUID();
    const jobDir = this.projects.jobDir(projectId, jobId);
    const candidate = path.join(jobDir, "candidate");
    await ensureDir(candidate);
    const configRef = path.join(jobDir, "config.json");
    await atomicWriteJson(configRef, rec.config);
    const job: JobDisk = {
      jobId, projectId, requestKey,
      configRevision: rec.config.configRevision,
      configDigest: rec.config.configDigest,
      state: "STARTING", stage: "STARTING",
      compileStatus: "unknown", snapshotStatus: "none", snapshotId: null,
      startedAt: now(), finishedAt: null, error: null, counts: {},
      diagnostics: { error: 0, warning: 0, note: 0, info: 0, truncated: false },
    };
    await this.projects.writeJob(job);
    this.projects.setActiveJob(projectId, jobId);
    this.emitBuild("job", job, baseSummary(job));

    const child = spawn(this.workerPath, ["--config", configRef, "--output", candidate, "--schema", this.schemaPath, "--job-id", jobId], {
      cwd: rec.config.workingDirectory,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.workerEnv(jobId, projectId),
    });
    const ab: ActiveBuild = {
      projectId, job, child, cancelRequested: false, artifact: null,
      workerError: null, finished: false, killTimer: null,
    };
    this.active.set(projectId, ab);

    child.on("error", (err) => {
      ab.workerError = { code: "IO_ERROR", message: `worker spawn failed: ${err.message}`, retryable: false };
    });
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        this.projects.appendWorkerLog(projectId, jobId, chunk.toString("utf8"));
      });
    }
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (line.length > LIMITS.maxWorkerFrameBytes) {
          ab.workerError = { code: "RESOURCE_LIMIT", message: "worker protocol frame too large", retryable: false };
          try { this.killTree(ab, "SIGKILL"); } catch { /* ignore */ }
          return;
        }
        if (!line.trim()) return;
        let msg: unknown;
        try { msg = JSON.parse(line); } catch {
          ab.workerError = { code: "INTERNAL_ERROR", message: "worker emitted invalid NDJSON", retryable: false };
          try { this.killTree(ab, "SIGKILL"); } catch { /* ignore */ }
          return;
        }
        this.onWorkerMessage(ab, msg).catch((err) => {
          ab.workerError = { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err), retryable: false };
          try { this.killTree(ab, "SIGKILL"); } catch { /* ignore */ }
        });
      });
    }
    // exit can precede the final stdout frame, especially on Windows. Wait for
    // close so the protocol and stderr pipes have drained before finalizing.
    child.on("close", (code, signal) => {
      console.error(`[build ${jobId}] worker close code=${String(code)} signal=${String(signal)} error=${ab.workerError?.code ?? "none"} artifact=${!!ab.artifact}`);
      void this.onExit(ab, code, signal).catch(async (err) => {
        console.error(`[build ${jobId}] onExit failed:`, err);
        try {
          this.active.delete(ab.projectId);
          this.projects.setActiveJob(ab.projectId, null);
          await this.update(ab.job, {
            state: "FAILED", stage: ab.job.stage, compileStatus: ab.job.compileStatus,
            snapshotStatus: "failed", finishedAt: now(),
            error: { code: "INTERNAL_ERROR", message: "build finalization failed", retryable: false },
          }, "done");
        } catch (again) {
          console.error(`[build ${jobId}] fallback failure update failed:`, again);
        }
      });
    });
    return { ...baseSummary(job), purged: prepared.purged };
  }

  private workerEnv(jobId: string, projectId: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    const temp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
    env.PATH = process.env.PATH ?? process.env.Path ?? "";
    env.HOME = home;
    env.USERPROFILE = process.env.USERPROFILE ?? home;
    env.TMPDIR = temp;
    env.TEMP = process.env.TEMP ?? temp;
    env.TMP = process.env.TMP ?? temp;
    env.LANG = process.env.LANG ?? "C.UTF-8";
    env.LC_ALL = process.env.LC_ALL ?? "C.UTF-8";
    env.RTL_JOB_ID = jobId;
    env.RTL_PROJECT_ID = projectId;
    if (process.platform === "win32") delete env.Path;
    return env;
  }

  private async onWorkerMessage(ab: ActiveBuild, raw: unknown): Promise<void> {
    if (ab.finished) return;
    let msg;
    try { msg = validateWorkerMessage(raw); } catch (err) {
      ab.workerError = { code: err instanceof AppError ? err.code : "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err), retryable: false };
      this.killTree(ab, "SIGKILL");
      return;
    }
    if (ab.cancelRequested) return;
    if (msg.type === "hello") {
      // Version and capabilities are validated by validateWorkerMessage; keep
      // the set for a future strict capability gate.
      return;
    }
    if (msg.type === "stage") {
      const state = msg.stage as BuildState;
      await this.update(ab.job, { state, stage: msg.stage }, "stage");
      return;
    }
    if (msg.type === "progress") {
      await this.update(ab.job, { counts: { ...ab.job.counts, ...msg.counts }, stage: msg.stage }, "stage");
      return;
    }
    if (msg.type === "diagnostic") {
      const d = msg.diagnostic as BuildDiagnostic;
      if (ab.job.diagnostics[d.severity] !== undefined) {
        if (ab.job.diagnostics[d.severity] < LIMITS.maxDiagnostics) {
          ab.job.diagnostics[d.severity]++;
          this.projects.appendDiagnostic(ab.projectId, ab.job.jobId, d);
        } else {
          ab.job.diagnostics.truncated = true;
        }
      }
      await this.update(ab.job, { diagnostics: { ...ab.job.diagnostics } }, "diagnostic");
      return;
    }
    if (msg.type === "artifact.ready") {
      ab.artifact = {
        manifestPath: msg.manifestPath,
        manifestSha256: msg.manifestSha256,
        snapshotId: msg.snapshotId,
        counts: msg.counts,
        capabilities: msg.capabilities,
      };
      return;
    }
    if (msg.type === "failed") {
      ab.workerError = msg.error;
      return;
    }
    if (msg.type === "cancelled") {
      ab.cancelRequested = true;
      return;
    }
  }

  private killTree(ab: ActiveBuild, signal: NodeJS.Signals): void {
    const pid = ab.child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") ab.child.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      try { ab.child.kill(signal); } catch { /* ignore */ }
    }
  }

  private async onExit(ab: ActiveBuild, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    console.error(`[build ${ab.job.jobId}] onExit state=${ab.job.state}`);
    if (ab.finished) return;
    ab.finished = true;
    if (ab.killTimer) clearTimeout(ab.killTimer);
    this.active.delete(ab.projectId);
    this.projects.setActiveJob(ab.projectId, null);

    if (ab.cancelRequested) {
      await this.update(ab.job, {
        state: "CANCELLED", stage: "CANCELLED", finishedAt: now(),
        snapshotStatus: "none", error: { code: "CANCELLED", message: "build cancelled", retryable: false },
      }, "done");
      return;
    }
    if (ab.workerError || code !== 0 || !ab.artifact) {
      const error = ab.workerError ?? {
        code: code === 0 ? "COMPILER_ERROR" : "COMPILER_ERROR",
        message: code === 0 ? "worker exited without an artifact" : `worker exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
        retryable: false,
      };
      await this.update(ab.job, {
        state: "FAILED", stage: ab.job.stage, compileStatus: "failed", snapshotStatus: "failed",
        finishedAt: now(), error,
      }, "done");
      return;
    }

    const artifact = ab.artifact;
    await this.update(ab.job, {
      state: "PUBLISHING", stage: "PUBLISHING", compileStatus: "succeeded",
      snapshotStatus: "building", counts: artifact.counts,
    }, "stage");
    try {
      const manifestPath = safeChild(path.join(this.projects.jobDir(ab.projectId, ab.job.jobId), "candidate"), artifact.manifestPath);
      if (!isWithin(path.join(this.projects.jobDir(ab.projectId, ab.job.jobId), "candidate"), manifestPath)) {
        throw new AppError("SNAPSHOT_CORRUPT", "manifest path escapes candidate output");
      }
      const required = new Set<string>(REQUIRED_CAPABILITIES as readonly string[]);
      for (const cap of required) {
        const c = artifact.capabilities[cap];
        if (!c || !c.present) throw new AppError("CAPABILITY_MISSING", `worker did not provide capability ${cap}`);
      }
      const published = await this.snapshots.publish(
        ab.projectId,
        ab.job.jobId,
        path.join(this.projects.jobDir(ab.projectId, ab.job.jobId), "candidate"),
        artifact.snapshotId,
      );
      try { this.projects.pruneSnapshots(ab.projectId, published.snapshotId); }
      catch (err) { console.error(`[build ${ab.job.jobId}] snapshot prune failed:`, err); }
      await this.update(ab.job, {
        state: "COMPLETE", stage: "COMPLETE", compileStatus: "succeeded",
        snapshotStatus: "complete", snapshotId: published.snapshotId,
        counts: artifact.counts, finishedAt: now(), error: null,
      }, "done");
    } catch (err) {
      await this.update(ab.job, {
        state: "FAILED", stage: "PUBLISHING", compileStatus: "succeeded", snapshotStatus: "failed",
        finishedAt: now(), error: {
          code: err instanceof AppError ? err.code : "SNAPSHOT_CORRUPT",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      }, "done");
    }
  }

  cancel(projectId: string, jobId: string): BuildJobSummary {
    const ab = this.active.get(projectId);
    if (!ab || ab.job.jobId !== jobId) {
      const job = this.projects.readJob(projectId, jobId);
      if (job.state === "COMPLETE" || job.state === "FAILED" || job.state === "CANCELLED") return baseSummary(job);
      throw new AppError("TASK_CONFLICT", "job is not active");
    }
    if (!ab.cancelRequested) {
      ab.cancelRequested = true;
      this.killTree(ab, "SIGTERM");
      ab.killTimer = setTimeout(() => this.killTree(ab, "SIGKILL"), 5000);
      ab.killTimer.unref?.();
    }
    return baseSummary(ab.job);
  }

  job(projectId: string, jobId: string): BuildJobSummary {
    const ab = this.active.get(projectId);
    if (ab?.job.jobId === jobId) return baseSummary(ab.job);
    return baseSummary(this.projects.readJob(projectId, jobId));
  }

  listJobs(projectId: string): BuildJobSummary[] {
    return this.projects.listJobs(projectId).map(baseSummary);
  }

  diagnosticsPage(projectId: string, jobId: string, filter: DiagnosticsFilter, cursor: unknown, limitRaw: unknown) {
    const job = this.projects.readJob(projectId, jobId);
    const limit = Math.min(1000, Math.max(1, typeof limitRaw === "number" ? Math.floor(limitRaw) : 200));
    const after = decodeDiagnosticCursor(jobId, filter, cursor);
    const all = this.projects.readDiagnostics(projectId, jobId) as BuildDiagnostic[];
    const filtered = all.filter((d) => (!filter.severity || d.severity === filter.severity) && (!filter.stage || d.stage === filter.stage));
    const start = filtered.findIndex((d) => d.sequence > after);
    const slice = start >= 0 ? filtered.slice(start, start + limit + 1) : [];
    const hasMore = slice.length > limit;
    const use = hasMore ? slice.slice(0, limit) : slice;
    const last = use[use.length - 1];
    return {
      records: use,
      nextCursor: hasMore && last ? encodeDiagnosticCursor(jobId, filter, last.sequence) : null,
      complete: !hasMore,
      total: filtered.length,
      counts: job.diagnostics,
    };
  }

  async cancelProject(projectId: string): Promise<void> {
    const ab = this.active.get(projectId);
    if (!ab) return;
    ab.cancelRequested = true;
    this.killTree(ab, "SIGTERM");
    for (let i = 0; i < 50 && this.active.has(projectId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.active.has(projectId)) {
      this.killTree(ab, "SIGKILL");
      for (let i = 0; i < 50 && this.active.has(projectId); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (this.active.has(projectId)) throw new AppError("TASK_CONFLICT", "build did not stop");
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = [...this.active.keys()];
    for (const projectId of active) {
      try { await this.cancelProject(projectId); } catch { /* best effort */ }
    }
  }
}
