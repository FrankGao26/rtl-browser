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

import { AppError } from "./errors.js";
import {
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type BuildConfig,
  type BuildRequest,
  type Capability,
  type SnapshotManifest,
  type WorkerMessage,
} from "./types.js";

function fail(message: string): never {
  throw new AppError("INVALID_INPUT", message);
}

function obj(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${label} must be an object`);
  return v as Record<string, unknown>;
}

function str(v: unknown, label: string, max = 1_000_000): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) fail(`${label} must be a non-empty string`);
  return v;
}

function maybeStr(v: unknown, label: string, max = 1_000_000): string | null {
  if (v === undefined || v === null) return null;
  return str(v, label, max);
}

function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") fail(`${label} must be boolean`);
  return v;
}

function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    fail(`${label} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function strArray(v: unknown, label: string, maxItems = 100_000): string[] {
  if (!Array.isArray(v)) fail(`${label} must be an array`);
  if (v.length > maxItems) fail(`${label} has too many entries`);
  return v.map((x, i) => str(x, `${label}[${i}]`));
}

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (REQUIRED_CAPABILITIES as readonly string[]).includes(v);
}

export function validateBuildConfig(v: unknown): BuildConfig {
  const o = obj(v, "config");
  if (o.protocolVersion !== PROTOCOL_VERSION) fail("unsupported protocolVersion");
  const inputMode = o.inputMode;
  if (inputMode !== "filelist" && inputMode !== "sources") fail("inputMode must be filelist or sources");
  const topMode = o.topMode;
  if (topMode !== "explicit" && topMode !== "automatic") fail("topMode must be explicit or automatic");
  const filelistMode = o.filelistMode;
  if (filelistMode !== undefined && filelistMode !== "-f" && filelistMode !== "-F") {
    fail("filelistMode must be -f or -F");
  }
  if (inputMode === "filelist" && typeof o.filelistPath !== "string") fail("filelistPath is required");
  if (inputMode === "sources" && !Array.isArray(o.sourcePaths)) fail("sourcePaths is required");

  const defines = Array.isArray(o.defines)
    ? o.defines.map((d, i) => {
        const x = obj(d, `defines[${i}]`);
        return { name: str(x.name, `defines[${i}].name`, 256), value: maybeStr(x.value, `defines[${i}].value`, 4096) };
      })
    : fail("defines must be an array");

  const parameters = Array.isArray(o.parameters)
    ? o.parameters.map((p, i) => {
        const x = obj(p, `parameters[${i}]`);
        return { name: str(x.name, `parameters[${i}].name`, 256), value: str(x.value, `parameters[${i}].value`, 4096) };
      })
    : fail("parameters must be an array");

  const configDigest = str(o.configDigest, "configDigest", 64);
  if (!/^[0-9a-f]{64}$/.test(configDigest)) fail("configDigest must be sha256 hex");

  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: str(o.projectId, "projectId", 128),
    name: str(o.name, "name", 256),
    projectRoot: str(o.projectRoot, "projectRoot"),
    inputMode,
    ...(inputMode === "filelist" ? { filelistPath: str(o.filelistPath, "filelistPath") } : {}),
    ...(filelistMode ? { filelistMode } : {}),
    ...(inputMode === "sources" ? { sourcePaths: strArray(o.sourcePaths, "sourcePaths") } : {}),
    workingDirectory: str(o.workingDirectory, "workingDirectory"),
    topMode,
    topModule: str(o.topModule, "topModule", 1024),
    sourceRoots: strArray(o.sourceRoots, "sourceRoots", 128),
    defines,
    includeRoots: strArray(o.includeRoots, "includeRoots", 10_000),
    libraries: strArray(o.libraries, "libraries", 10_000),
    parameters,
    language: maybeStr(o.language, "language", 64),
    singleUnit: bool(o.singleUnit, "singleUnit"),
    threads: int(o.threads, "threads", 1, 64),
    warningAsError: bool(o.warningAsError, "warningAsError"),
    warningOptions: Array.isArray(o.warningOptions) ? o.warningOptions.map((x, i) => str(x, `warningOptions[${i}]`, 128)) : [],
    configRevision: int(o.configRevision, "configRevision", 1, Number.MAX_SAFE_INTEGER),
    configDigest,
  };
}

export function validateBuildRequest(v: unknown): BuildRequest {
  const o = obj(v, "request");
  if (o.protocolVersion !== PROTOCOL_VERSION) fail("unsupported protocolVersion");
  const caps = o.requiredCapabilities;
  if (!Array.isArray(caps) || caps.length === 0 || !caps.every(isCapability)) fail("requiredCapabilities is invalid");
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: str(o.jobId, "jobId", 128),
    projectId: str(o.projectId, "projectId", 128),
    configRef: str(o.configRef, "configRef"),
    outputRef: str(o.outputRef, "outputRef"),
    requiredCapabilities: caps,
    requestKey: str(o.requestKey, "requestKey", 256),
  };
}

export function validateWorkerMessage(v: unknown): WorkerMessage {
  const o = obj(v, "worker message");
  if (o.protocolVersion !== PROTOCOL_VERSION) {
    throw new AppError("UNSUPPORTED_VERSION", "worker protocol version is unsupported");
  }
  str(o.jobId, "jobId", 128);
  int(o.seq, "seq", 0, Number.MAX_SAFE_INTEGER);
  const t = o.type;
  if (t === "hello") {
    if (!Array.isArray(o.capabilities) || !o.capabilities.every(isCapability)) fail("hello capabilities invalid");
    str(o.compilerVersion, "compilerVersion", 256);
    str(o.extractorVersion, "extractorVersion", 64);
  } else if (t === "stage") {
    if (!["COMPILING", "EXTRACTING", "INDEXING", "VALIDATING"].includes(String(o.stage))) fail("stage invalid");
    if (!["start", "finish", "fail", "cancel"].includes(String(o.state))) fail("stage state invalid");
  } else if (t === "progress") {
    obj(o.counts, "progress.counts");
    int(o.elapsedMs, "progress.elapsedMs", 0, Number.MAX_SAFE_INTEGER);
  } else if (t === "diagnostic") {
    obj(o.diagnostic, "diagnostic");
  } else if (t === "artifact.ready") {
    str(o.manifestPath, "manifestPath");
    if (!/^[0-9a-f]{64}$/.test(String(o.manifestSha256))) fail("manifestSha256 invalid");
    str(o.snapshotId, "snapshotId", 128);
    obj(o.counts, "counts");
    obj(o.capabilities, "capabilities");
  } else if (t === "failed") {
    obj(o.error, "error");
  } else if (t !== "cancelled") {
    fail("unknown worker message type");
  }
  return o as unknown as WorkerMessage;
}

export function validateManifest(v: unknown): SnapshotManifest {
  const o = obj(v, "manifest");
  if (o.schemaVersion !== 1 || o.protocolVersion !== PROTOCOL_VERSION) fail("manifest version unsupported");
  const sources = Array.isArray(o.sources) ? o.sources : fail("manifest.sources must be an array");
  for (const [i, s] of sources.entries()) {
    const x = obj(s, `sources[${i}]`);
    str(x.sourceId, `sources[${i}].sourceId`);
    if (!/^[0-9]+$/.test(String(x.sourceId))) fail(`sources[${i}].sourceId must be decimal`);
    str(x.displayPath, `sources[${i}].displayPath`);
    if (!/^[0-9a-f]{64}$/.test(String(x.sha256))) fail(`sources[${i}].sha256 invalid`);
    int(x.bytes, `sources[${i}].bytes`, 0, Number.MAX_SAFE_INTEGER);
  }
  if (!Array.isArray(o.capabilities) || !o.capabilities.every(isCapability)) fail("manifest.capabilities invalid");
  obj(o.capabilityComplete, "manifest.capabilityComplete");
  obj(o.counts, "manifest.counts");
  if (!/^[0-9a-f]{64}$/.test(String(o.indexSha256))) fail("manifest.indexSha256 invalid");
  if (o.status !== "READY" && o.status !== "COMPLETE") fail("manifest.status invalid");
  return o as unknown as SnapshotManifest;
}

export function assertDisplayPath(v: string): void {
  if (v.startsWith("/") || v.startsWith("//") || /^[A-Za-z]:/.test(v) ||
      v.includes("\\") || v.split("/").includes("..")) {
    fail("display path must be relative and must not contain '..'");
  }
}
