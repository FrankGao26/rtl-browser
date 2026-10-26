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
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../../contracts/src/errors.js";
import { assertDisplayPath, validateManifest } from "../../contracts/src/validation.js";
import type { BuildConfig, SnapshotManifest, SnapshotSummary } from "../../contracts/src/types.js";
import { atomicWriteJson, ensureDir, fsyncDir, readonlyMode, rmRetry, rmSyncRetry, sha256File } from "./paths.js";
import { ProjectStore } from "./projectStore.js";

export interface PublishResult {
  snapshotId: string;
  manifestSha256: string;
  snapshotDir: string;
  manifest: SnapshotManifest;
}

export async function verifySourceFiles(dir: string, manifest: SnapshotManifest): Promise<void> {
  const sourcesDir = path.join(dir, "sources");
  for (const s of manifest.sources) {
    assertDisplayPath(s.displayPath);
    if (!/^[0-9a-f]{64}$/.test(s.sha256)) throw new AppError("SNAPSHOT_CORRUPT", "source digest invalid");
    const file = path.join(sourcesDir, `${s.sha256}.bin`);
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw new AppError("SOURCE_UNAVAILABLE", `source blob missing: ${s.displayPath}`);
    if (st.size !== s.bytes) throw new AppError("SOURCE_MISMATCH", `source size mismatch: ${s.displayPath}`);
    if (await sha256File(file) !== s.sha256) throw new AppError("SOURCE_MISMATCH", `source hash mismatch: ${s.displayPath}`);
  }
}

export function verifyDatabase(file: string): void {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false, defensive: true, timeout: 1000 });
    const uv = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    if (!uv || Number(uv.user_version) !== 1) throw new AppError("SNAPSHOT_CORRUPT", "snapshot schema version mismatch");
    const app = db.prepare("PRAGMA application_id").get() as Record<string, unknown> | undefined;
    if (!app || Number(app.application_id) !== 1381256258) {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot application id mismatch");
    }
    const check = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    const ok = check ? String(Object.values(check)[0] ?? "") : "";
    if (ok.toLowerCase() !== "ok") throw new AppError("SNAPSHOT_CORRUPT", "SQLite integrity check failed");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, unknown>>;
    const names = new Set(tables.map((r) => String(r.name)));
    for (const required of ["instance", "symbol", "occurrence", "driver", "load_edge", "source_file", "source_line", "preprocessor_region"]) {
      if (!names.has(required)) throw new AppError("SNAPSHOT_CORRUPT", `missing table ${required}`);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("SNAPSHOT_CORRUPT", `cannot open snapshot database: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db?.close();
  }
}

export class SnapshotStore {
  readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  manifest(projectId: string, snapshotId: string): SnapshotManifest {
    const file = path.join(this.projects.snapshotDir(projectId, snapshotId), "manifest.json");
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      throw new AppError("SNAPSHOT_INCOMPLETE", "snapshot manifest is unavailable");
    }
    const manifest = validateManifest(parsed);
    if (manifest.projectId !== projectId || manifest.snapshotId !== snapshotId || manifest.status !== "COMPLETE") {
      throw new AppError("SNAPSHOT_INCOMPLETE", "snapshot is not published for this project");
    }
    return manifest;
  }

  list(projectId: string): SnapshotSummary[] {
    const dir = path.join(this.projects.projectDir(projectId), "snapshots");
    if (!fs.existsSync(dir)) return [];
    const out: SnapshotSummary[] = [];
    for (const name of fs.readdirSync(dir)) {
      try {
        const m = this.manifest(projectId, name);
        out.push({
          snapshotId: m.snapshotId,
          projectId: m.projectId,
          rootPath: m.rootPath,
          topModule: m.topModule,
          compilerVersion: m.compilerVersion,
          createdAt: m.createdAt,
          counts: m.counts,
          capabilities: m.capabilities,
        });
      } catch { /* incomplete/corrupt directories are not listed */ }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  async pruneToSingle(projectId: string): Promise<SnapshotSummary | null> {
    const snapshots = this.list(projectId);
    if (snapshots.length === 0) {
      const rec = this.projects.get(projectId);
      if (rec.currentSnapshotId !== null) this.projects.clearCurrentSnapshot(projectId);
      return null;
    }
    const rec = this.projects.get(projectId);
    const chosen = snapshots.find((s) => s.snapshotId === rec.currentSnapshotId) ?? snapshots[0];
    this.projects.pruneSnapshots(projectId, chosen.snapshotId);
    const manifestFile = path.join(this.projects.snapshotDir(projectId, chosen.snapshotId), "manifest.json");
    if (fs.existsSync(manifestFile)) {
      await this.projects.setCurrentSnapshot(projectId, chosen.snapshotId, await sha256File(manifestFile));
    }
    return chosen;
  }

  /**
   * Install a validated imported snapshot as this session's single snapshot.
   * The source manifest's projectId is rewritten; the source BuildConfig is
   * kept alongside the snapshot so the bundle can be exported again without
   * depending on (possibly different) local project settings.
   */
  async installImported(
    projectId: string,
    stagingDir: string,
    manifest: SnapshotManifest,
    originConfig: BuildConfig,
  ): Promise<{ manifest: SnapshotManifest; manifestSha256: string }> {
    const rewritten: SnapshotManifest = { ...manifest, projectId };
    await atomicWriteJson(path.join(stagingDir, "manifest.json"), rewritten, readonlyMode());
    await atomicWriteJson(path.join(stagingDir, "origin-config.json"), originConfig, 0o600);
    const manifestSha256 = await sha256File(path.join(stagingDir, "manifest.json"));
    const finalDir = this.projects.snapshotDir(projectId, rewritten.snapshotId);
    await ensureDir(path.dirname(finalDir));
    if (fs.existsSync(finalDir)) rmSyncRetry(finalDir);
    await fsyncDir(stagingDir);
    await fsp.rename(stagingDir, finalDir);
    await fsyncDir(path.dirname(finalDir));
    this.projects.pruneSnapshots(projectId, rewritten.snapshotId);
    this.projects.setCurrentSnapshot(projectId, rewritten.snapshotId, manifestSha256);
    return { manifest: rewritten, manifestSha256 };
  }

  async publish(projectId: string, jobId: string, candidateDir: string, expectedSnapshotId: string): Promise<PublishResult> {
    const manifestPath = path.join(candidateDir, "manifest.json");
    let raw: unknown;
    try { raw = JSON.parse(await fsp.readFile(manifestPath, "utf8")); } catch {
      throw new AppError("SNAPSHOT_CORRUPT", "worker manifest is missing or invalid");
    }
    const manifest = validateManifest(raw);
    if (manifest.projectId !== projectId) throw new AppError("SNAPSHOT_MISMATCH", "manifest project does not match the job");
    if (manifest.jobId !== jobId) throw new AppError("SNAPSHOT_MISMATCH", "manifest job does not match");
    if (manifest.snapshotId !== expectedSnapshotId) throw new AppError("SNAPSHOT_MISMATCH", "manifest snapshot does not match");
    if (manifest.status !== "READY") throw new AppError("SNAPSHOT_INCOMPLETE", "worker candidate is not READY");

    const dbPath = path.join(candidateDir, "index.sqlite");
    if (!fs.existsSync(dbPath)) throw new AppError("SNAPSHOT_CORRUPT", "index.sqlite missing");
    if (await sha256File(dbPath) !== manifest.indexSha256) throw new AppError("SNAPSHOT_CORRUPT", "index digest mismatch");
    verifyDatabase(dbPath);
    await verifySourceFiles(candidateDir, manifest);

    const finalManifest: SnapshotManifest = { ...manifest, status: "COMPLETE" };
    await atomicWriteJson(path.join(candidateDir, "manifest.json"), finalManifest, readonlyMode());
    const finalManifestSha = await sha256File(path.join(candidateDir, "manifest.json"));

    const finalDir = this.projects.snapshotDir(projectId, manifest.snapshotId);
    if (fs.existsSync(finalDir)) {
      let existing: SnapshotManifest;
      try { existing = this.manifest(projectId, manifest.snapshotId); }
      catch { throw new AppError("TASK_CONFLICT", "snapshot directory exists but is not a complete published snapshot"); }
      const same = existing.configDigest === manifest.configDigest &&
        existing.indexSha256 === manifest.indexSha256 &&
        existing.topModule === manifest.topModule &&
        JSON.stringify(existing.sources) === JSON.stringify(manifest.sources);
      if (!same) throw new AppError("TASK_CONFLICT", "snapshot id already exists with different content");
      const existingManifestSha = await sha256File(path.join(finalDir, "manifest.json"));
      this.projects.setCurrentSnapshot(projectId, manifest.snapshotId, existingManifestSha);
      await rmRetry(candidateDir).catch(() => {});
      return { snapshotId: manifest.snapshotId, manifestSha256: existingManifestSha, snapshotDir: finalDir, manifest: existing };
    }
    await ensureDir(path.dirname(finalDir));
    await fsyncDir(candidateDir);
    await fsp.rename(candidateDir, finalDir);
    await fsyncDir(path.dirname(finalDir));

    const pointer = this.projects.setCurrentSnapshot(projectId, manifest.snapshotId, finalManifestSha);
    if (pointer.snapshotId !== manifest.snapshotId) throw new AppError("INTERNAL_ERROR", "current pointer mismatch");
    return { snapshotId: manifest.snapshotId, manifestSha256: finalManifestSha, snapshotDir: finalDir, manifest: finalManifest };
  }

  snapshotPath(projectId: string, snapshotId: string): string {
    this.manifest(projectId, snapshotId);
    return this.projects.snapshotDir(projectId, snapshotId);
  }
}
