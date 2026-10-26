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
import { LIMITS } from "../../contracts/src/limits.js";
import {
  EXTRACTOR_VERSION,
  PROJECT_FORMAT_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type BuildConfig,
  type SnapshotManifest,
  type SnapshotSource,
} from "../../contracts/src/types.js";
import { assertDisplayPath, validateBuildConfig, validateManifest } from "../../contracts/src/validation.js";
import { sha256File } from "./paths.js";
import { verifyDatabase, verifySourceFiles } from "./snapshotStore.js";

const MAGIC = Buffer.from("RTLSNAP1", "ascii");
const CONTAINER_FORMAT_VERSION = 1;
const PREAMBLE_BYTES = 8 + 4 + 4 + 32;

export interface SnapshotBundleEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SnapshotBundleHeader {
  containerFormatVersion: number;
  programVersion: string;
  projectFormatVersion: number;
  schemaVersion: number;
  protocolVersion: number;
  extractorVersion: string;
  compilerVersion: string;
  compilerCommit: string;
  sourceProjectId: string;
  snapshotId: string;
  topModule: string;
  manifestSha256: string;
  config: BuildConfig;
  entries: SnapshotBundleEntry[];
}

export interface ExportBundleOptions {
  snapshotDir: string;
  manifest: SnapshotManifest;
  config: BuildConfig;
  outputFile: string;
  programVersion: string;
}

export interface ImportedBundle {
  manifest: SnapshotManifest;
  config: BuildConfig;
  sourceProjectId: string;
  manifestSha256: string;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

function hex(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new AppError("INVALID_INPUT", `${label} is not a sha256 digest`);
  return value;
}

function safeEntryKind(entryPath: string): { kind: "manifest" | "index" | "source"; sha?: string } {
  if (entryPath === "manifest.json") return { kind: "manifest" };
  if (entryPath === "index.sqlite") return { kind: "index" };
  const m = /^sources\/([0-9a-f]{64})\.bin$/.exec(entryPath);
  if (m) return { kind: "source", sha: m[1] };
  throw new AppError("INVALID_INPUT", `snapshot entry path is not allowed: ${entryPath}`);
}

function validSnapshotId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function versionMismatch(stored: unknown, current: number | string, field: string): never {
  throw new AppError("SNAPSHOT_VERSION_MISMATCH", `snapshot ${field} does not match this program`, {
    details: { field, stored, current },
  });
}

export function assertBundleCompatible(header: SnapshotBundleHeader): void {
  if (header.containerFormatVersion !== CONTAINER_FORMAT_VERSION) {
    versionMismatch(header.containerFormatVersion, CONTAINER_FORMAT_VERSION, "containerFormatVersion");
  }
  if (header.projectFormatVersion !== PROJECT_FORMAT_VERSION) {
    versionMismatch(header.projectFormatVersion, PROJECT_FORMAT_VERSION, "projectFormatVersion");
  }
  if (header.schemaVersion !== SCHEMA_VERSION) {
    versionMismatch(header.schemaVersion, SCHEMA_VERSION, "schemaVersion");
  }
  if (header.protocolVersion !== PROTOCOL_VERSION) {
    versionMismatch(header.protocolVersion, PROTOCOL_VERSION, "protocolVersion");
  }
  if (header.extractorVersion !== EXTRACTOR_VERSION) {
    versionMismatch(header.extractorVersion, EXTRACTOR_VERSION, "extractorVersion");
  }
}

function checkManifestAgainstHeader(header: SnapshotBundleHeader, manifest: SnapshotManifest): void {
  if (manifest.status !== "COMPLETE") throw new AppError("SNAPSHOT_INCOMPLETE", "snapshot bundle is not complete");
  if (manifest.snapshotId !== header.snapshotId) throw new AppError("SNAPSHOT_MISMATCH", "snapshot id mismatch");
  if (manifest.projectId !== header.sourceProjectId) throw new AppError("SNAPSHOT_MISMATCH", "source project id mismatch");
  if (manifest.topModule !== header.topModule) throw new AppError("SNAPSHOT_MISMATCH", "top module mismatch");
  if (manifest.schemaVersion !== header.schemaVersion ||
      manifest.protocolVersion !== header.protocolVersion ||
      manifest.extractorVersion !== header.extractorVersion) {
    throw new AppError("SNAPSHOT_MISMATCH", "snapshot version metadata mismatch");
  }
  if (manifest.compilerVersion !== header.compilerVersion ||
      manifest.compilerCommit !== header.compilerCommit) {
    throw new AppError("SNAPSHOT_MISMATCH", "snapshot compiler metadata mismatch");
  }
  if (manifest.configDigest !== header.config.configDigest) {
    throw new AppError("SNAPSHOT_MISMATCH", "snapshot config digest mismatch");
  }
}

function sourceMap(manifest: SnapshotManifest): Map<string, SnapshotSource> {
  const out = new Map<string, SnapshotSource>();
  for (const source of manifest.sources) {
    assertDisplayPath(source.displayPath);
    const key = String(source.sourceId);
    if (!/^[0-9]+$/.test(key)) throw new AppError("SNAPSHOT_CORRUPT", "source id is not decimal");
    if (out.has(key)) throw new AppError("SNAPSHOT_CORRUPT", "duplicate source id");
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) {
      throw new AppError("SNAPSHOT_CORRUPT", "invalid source size");
    }
    hex(source.sha256, "source sha256");
    out.set(key, source);
  }
  return out;
}

function verifyDatabaseSourceClosure(indexFile: string, manifest: SnapshotManifest): void {
  const db = new DatabaseSync(indexFile, {
    readOnly: true, readBigInts: true, allowExtension: false, defensive: true, timeout: 1000,
  });
  try {
    const rows = db.prepare("SELECT id,display_path,blob_sha,byte_length FROM source_file").all() as Array<Record<string, unknown>>;
    const expected = sourceMap(manifest);
    if (rows.length !== expected.size) throw new AppError("SNAPSHOT_CORRUPT", "source_file count does not match manifest");
    for (const row of rows) {
      const source = expected.get(String(row.id));
      if (!source) throw new AppError("SNAPSHOT_CORRUPT", "source_file contains an unknown source");
      if (String(row.display_path) !== source.displayPath ||
          String(row.blob_sha) !== source.sha256 ||
          Number(row.byte_length) !== source.bytes) {
        throw new AppError("SNAPSHOT_CORRUPT", "source_file does not match manifest");
      }
    }
    const root = db.prepare("SELECT path,module_name FROM instance WHERE id=?").get(manifest.rootInstanceId) as Record<string, unknown> | undefined;
    if (!root || String(root.path) !== manifest.rootPath || String(root.module_name) !== manifest.topModule) {
      throw new AppError("SNAPSHOT_CORRUPT", "root instance does not match manifest");
    }
  } finally {
    db.close();
  }
}

async function writeAll(handle: fsp.FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new AppError("IO_ERROR", "short write while creating snapshot bundle");
    offset += bytesWritten;
  }
}

async function copyFileInto(handle: fsp.FileHandle, sourceFile: string, expectedSha: string, expectedBytes: number): Promise<string> {
  const input = await fsp.open(sourceFile, "r");
  const hash = crypto.createHash("sha256");
  let total = 0;
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expectedBytes) throw new AppError("SNAPSHOT_MISMATCH", "snapshot file grew during export");
      hash.update(chunk.subarray(0, bytesRead));
      await writeAll(handle, chunk.subarray(0, bytesRead));
    }
  } finally {
    await input.close();
  }
  const digest = hash.digest("hex");
  if (total !== expectedBytes || digest !== expectedSha) {
    throw new AppError("SNAPSHOT_MISMATCH", "snapshot file changed during export");
  }
  return digest;
}

async function copyEntryInto(bundle: fsp.FileHandle, offset: number,
                             bytes: number, destination: string, expectedSha: string): Promise<void> {
  const hash = crypto.createHash("sha256");
  const out = await fsp.open(destination, "wx", 0o600);
  let position = offset;
  let remaining = bytes;
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (remaining > 0) {
      const want = Math.min(chunk.length, remaining);
      const { bytesRead } = await bundle.read(chunk, 0, want, position);
      if (bytesRead === 0) throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle is truncated");
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const r = await out.write(chunk, written, bytesRead - written);
        if (r.bytesWritten <= 0) throw new AppError("IO_ERROR", "short write while importing snapshot");
        written += r.bytesWritten;
      }
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await out.close();
  }
  if (hash.digest("hex") !== expectedSha) throw new AppError("SNAPSHOT_CORRUPT", "snapshot entry hash mismatch");
}

export async function exportSnapshotBundle(opts: ExportBundleOptions): Promise<{ bytes: number }> {
  const { snapshotDir, manifest, config, outputFile, programVersion } = opts;
  if (manifest.projectId !== config.projectId) {
    throw new AppError("SNAPSHOT_MISMATCH", "snapshot does not belong to the current project");
  }
  // Imported snapshots keep the source configuration; otherwise the snapshot
  // was built from the current project configuration.
  let exportConfig = config;
  const originConfigFile = path.join(snapshotDir, "origin-config.json");
  if (fs.existsSync(originConfigFile)) {
    try {
      exportConfig = validateBuildConfig(JSON.parse(await fsp.readFile(originConfigFile, "utf8")));
    } catch {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot origin configuration is invalid");
    }
  }
  if (manifest.configDigest !== exportConfig.configDigest) {
    throw new AppError("SNAPSHOT_MISMATCH", "snapshot configuration digest does not match");
  }
  const manifestFile = path.join(snapshotDir, "manifest.json");
  const indexFile = path.join(snapshotDir, "index.sqlite");
  const manifestBytes = await fsp.readFile(manifestFile);
  const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  const indexSha = await sha256File(indexFile);
  if (indexSha !== manifest.indexSha256) throw new AppError("SNAPSHOT_CORRUPT", "snapshot index hash mismatch");
  verifyDatabase(indexFile);
  await verifySourceFiles(snapshotDir, manifest);
  verifyDatabaseSourceClosure(indexFile, manifest);

  const sourceShas = [...new Set(manifest.sources.map((s) => s.sha256))].sort();
  const entries: SnapshotBundleEntry[] = [
    { path: "manifest.json", sha256: manifestSha, bytes: manifestBytes.length },
    { path: "index.sqlite", sha256: indexSha, bytes: (await fsp.stat(indexFile)).size },
    ...sourceShas.map((sha) => {
      const source = manifest.sources.find((s) => s.sha256 === sha)!;
      return { path: `sources/${sha}.bin`, sha256: sha, bytes: source.bytes };
    }),
  ];
  const header: SnapshotBundleHeader = {
    containerFormatVersion: CONTAINER_FORMAT_VERSION,
    programVersion,
    projectFormatVersion: PROJECT_FORMAT_VERSION,
    schemaVersion: manifest.schemaVersion,
    protocolVersion: manifest.protocolVersion,
    extractorVersion: manifest.extractorVersion,
    compilerVersion: manifest.compilerVersion,
    compilerCommit: manifest.compilerCommit,
    sourceProjectId: manifest.projectId,
    snapshotId: manifest.snapshotId,
    topModule: manifest.topModule,
    manifestSha256: manifestSha,
    config: exportConfig,
    entries,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > LIMITS.maxSnapshotBundleHeaderBytes) {
    throw new AppError("RESOURCE_LIMIT", "snapshot bundle header is too large");
  }
  const handle = await fsp.open(outputFile, "wx", 0o600);
  try {
    await writeAll(handle, MAGIC);
    await writeAll(handle, u32(CONTAINER_FORMAT_VERSION));
    await writeAll(handle, u32(headerBytes.length));
    await writeAll(handle, crypto.createHash("sha256").update(headerBytes).digest());
    await writeAll(handle, headerBytes);
    await copyFileInto(handle, manifestFile, manifestSha, manifestBytes.length);
    await copyFileInto(handle, indexFile, indexSha, entries[1].bytes);
    for (const sha of sourceShas) {
      const source = manifest.sources.find((s) => s.sha256 === sha)!;
      await copyFileInto(handle, path.join(snapshotDir, "sources", `${sha}.bin`), sha, source.bytes);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, PREAMBLE_BYTES + headerBytes.length) };
}

export async function importSnapshotBundle(bundleFile: string, stagingDir: string): Promise<ImportedBundle> {
  const stat = await fsp.stat(bundleFile);
  if (stat.size > LIMITS.maxSnapshotBundleBytes) throw new AppError("RESOURCE_LIMIT", "snapshot bundle is too large");
  const bundle = await fsp.open(bundleFile, "r");
  try {
    const preamble = Buffer.alloc(PREAMBLE_BYTES);
    const pre = await bundle.read(preamble, 0, preamble.length, 0);
    if (pre.bytesRead !== preamble.length) throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle is truncated");
    if (!preamble.subarray(0, 8).equals(MAGIC)) throw new AppError("INVALID_INPUT", "not a .rtlbsnap snapshot");
    const containerVersion = preamble.readUInt32LE(8);
    const headerLen = preamble.readUInt32LE(12);
    if (containerVersion !== CONTAINER_FORMAT_VERSION) {
      versionMismatch(containerVersion, CONTAINER_FORMAT_VERSION, "containerFormatVersion");
    }
    if (headerLen < 1 || headerLen > LIMITS.maxSnapshotBundleHeaderBytes) {
      throw new AppError("RESOURCE_LIMIT", "snapshot bundle header size is invalid");
    }
    const headerBytes = Buffer.alloc(headerLen);
    const hr = await bundle.read(headerBytes, 0, headerLen, PREAMBLE_BYTES);
    if (hr.bytesRead !== headerLen) throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle header is truncated");
    if (!crypto.createHash("sha256").update(headerBytes).digest().equals(preamble.subarray(16, 48))) {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle header hash mismatch");
    }
    let header: SnapshotBundleHeader;
    try { header = JSON.parse(headerBytes.toString("utf8")) as SnapshotBundleHeader; }
    catch { throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle header is not valid JSON"); }
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle header is invalid");
    }
    assertBundleCompatible(header);
    if (typeof header.programVersion !== "string" ||
        typeof header.config !== "object" || header.config === null || Array.isArray(header.config) ||
        !Array.isArray(header.entries) ||
        !validSnapshotId(header.snapshotId) ||
        typeof header.sourceProjectId !== "string" || header.sourceProjectId.length === 0 || header.sourceProjectId.length > 128 ||
        typeof header.topModule !== "string" || header.topModule.length === 0 || header.topModule.length > 1024 ||
        typeof header.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(header.manifestSha256)) {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle header is invalid");
    }
    const config = validateBuildConfig(header.config);
    const entries = header.entries;
    if (entries.length < 2 || entries.length > LIMITS.maxSnapshotBundleEntries) {
      throw new AppError("RESOURCE_LIMIT", "snapshot bundle entry count is invalid");
    }
    const seen = new Set<string>();
    const sourceEntries = new Map<string, SnapshotBundleEntry>();
    let manifestEntry: SnapshotBundleEntry | null = null;
    let indexEntry: SnapshotBundleEntry | null = null;
    let payloadBytes = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle entry is invalid");
      }
      hex(entry.sha256, "entry sha256");
      if (seen.has(entry.path)) throw new AppError("SNAPSHOT_CORRUPT", "duplicate snapshot entry");
      seen.add(entry.path);
      const kind = safeEntryKind(entry.path);
      if (kind.kind === "manifest") {
        if (manifestEntry) throw new AppError("SNAPSHOT_CORRUPT", "duplicate manifest entry");
        manifestEntry = entry;
      } else if (kind.kind === "index") {
        if (indexEntry) throw new AppError("SNAPSHOT_CORRUPT", "duplicate index entry");
        indexEntry = entry;
      } else {
        if (kind.sha !== entry.sha256) throw new AppError("SNAPSHOT_CORRUPT", "source entry hash does not match its filename");
        sourceEntries.set(entry.sha256, entry);
      }
      if (entry.bytes > LIMITS.maxSourceFileBytes) {
        throw new AppError("RESOURCE_LIMIT", "snapshot bundle entry is too large");
      }
      payloadBytes += entry.bytes;
      if (payloadBytes > LIMITS.maxSnapshotBundleBytes) {
        throw new AppError("RESOURCE_LIMIT", "snapshot bundle payload is too large");
      }
    }
    if (!manifestEntry || !indexEntry) throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle is missing manifest or index");
    const expectedSize = PREAMBLE_BYTES + headerLen + payloadBytes;
    if (stat.size !== expectedSize) throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle has trailing or missing data");

    await fsp.mkdir(stagingDir, { recursive: false, mode: 0o700 });
    await fsp.mkdir(path.join(stagingDir, "sources"), { recursive: false, mode: 0o700 });
    let offset = PREAMBLE_BYTES + headerLen;
    for (const entry of entries) {
      const kind = safeEntryKind(entry.path);
      const destination = kind.kind === "manifest" ? path.join(stagingDir, "manifest.json")
        : kind.kind === "index" ? path.join(stagingDir, "index.sqlite")
          : path.join(stagingDir, "sources", `${entry.sha256}.bin`);
      await copyEntryInto(bundle, offset, entry.bytes, destination, entry.sha256);
      offset += entry.bytes;
    }
    let manifestRaw: unknown;
    try { manifestRaw = JSON.parse(await fsp.readFile(path.join(stagingDir, "manifest.json"), "utf8")); }
    catch { throw new AppError("SNAPSHOT_CORRUPT", "snapshot manifest is not valid JSON"); }
    const manifest = validateManifest(manifestRaw);
    if (!validSnapshotId(manifest.snapshotId) || !validSnapshotId(manifest.projectId) ||
        !/^[0-9]+$/.test(String(manifest.rootInstanceId)) ||
        typeof manifest.rootPath !== "string" || manifest.rootPath.length === 0 ||
        typeof manifest.topModule !== "string" || manifest.topModule.length === 0) {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot manifest identity is invalid");
    }
    if (manifest.extractorVersion !== EXTRACTOR_VERSION) {
      versionMismatch(manifest.extractorVersion, EXTRACTOR_VERSION, "extractorVersion");
    }
    const manifestSha = await sha256File(path.join(stagingDir, "manifest.json"));
    if (manifestSha !== header.manifestSha256 || manifestSha !== manifestEntry.sha256) {
      throw new AppError("SNAPSHOT_CORRUPT", "snapshot manifest hash mismatch");
    }
    checkManifestAgainstHeader(header, manifest);
    if (manifest.indexSha256 !== indexEntry.sha256) throw new AppError("SNAPSHOT_CORRUPT", "snapshot index hash mismatch");
    const sources = sourceMap(manifest);
    for (const source of sources.values()) {
      const entry = sourceEntries.get(source.sha256);
      if (!entry || entry.bytes !== source.bytes) {
        throw new AppError("SNAPSHOT_CORRUPT", "manifest source is missing from the bundle");
      }
    }
    for (const [sha, entry] of sourceEntries) {
      if (!manifest.sources.some((source) => source.sha256 === sha && source.bytes === entry.bytes)) {
        throw new AppError("SNAPSHOT_CORRUPT", "snapshot bundle contains an unrelated source blob");
      }
    }
    verifyDatabase(path.join(stagingDir, "index.sqlite"));
    await verifySourceFiles(stagingDir, manifest);
    verifyDatabaseSourceClosure(path.join(stagingDir, "index.sqlite"), manifest);
    return { manifest, config, sourceProjectId: header.sourceProjectId, manifestSha256: manifestSha };
  } finally {
    await bundle.close();
  }
}
