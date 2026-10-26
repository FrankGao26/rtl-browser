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

export const PROTOCOL_VERSION = 1 as const;
export const SCHEMA_VERSION = 1 as const;
export const PROJECT_FORMAT_VERSION = 1 as const;
export const EXTRACTOR_VERSION = "0.9.11";

export type Capability =
  | "hierarchy"
  | "resolved-symbols"
  | "types-values"
  | "drivers-bit-mapping"
  | "loads-direct-dependencies"
  | "preprocessor-provenance"
  | "definition-links"
  | "source-snapshot";

export const REQUIRED_CAPABILITIES: readonly Capability[] = [
  "hierarchy",
  "resolved-symbols",
  "types-values",
  "drivers-bit-mapping",
  "loads-direct-dependencies",
  "preprocessor-provenance",
  "definition-links",
  "source-snapshot",
] as const;

export interface CapabilityStatus {
  present: boolean;
  complete: boolean;
  reason: string | null;
}

export interface Define {
  name: string;
  value?: string | null;
}

export interface ParameterOverride {
  name: string;
  value: string;
}

export interface BuildConfig {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  name: string;
  projectRoot: string;
  inputMode: "filelist" | "sources";
  filelistPath?: string;
  filelistMode?: "-f" | "-F";
  sourcePaths?: string[];
  workingDirectory: string;
  topMode: "explicit" | "automatic";
  topModule: string;
  sourceRoots: string[];
  defines: Define[];
  includeRoots: string[];
  libraries: string[];
  parameters: ParameterOverride[];
  language: string | null;
  singleUnit: boolean;
  threads: number;
  warningAsError: boolean;
  warningOptions: string[];
  configRevision: number;
  configDigest: string;
}

export interface BuildRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  projectId: string;
  configRef: string;
  outputRef: string;
  requiredCapabilities: Capability[];
  requestKey: string;
}

export interface DiagnosticLocation {
  displayPath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface DiagnosticNote {
  severity: "error" | "warning" | "note" | "info";
  message: string;
  primaryLocation?: DiagnosticLocation;
}

export interface BuildDiagnostic {
  sequence: number;
  stage: string;
  severity: "error" | "warning" | "note" | "info";
  code: string;
  message: string;
  primaryLocation?: DiagnosticLocation;
  relatedNotes?: DiagnosticNote[];
}

interface WorkerBase {
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  seq: number;
}

export interface WorkerHello extends WorkerBase {
  type: "hello";
  capabilities: Capability[];
  compilerVersion: string;
  extractorVersion: string;
}

export interface WorkerStage extends WorkerBase {
  type: "stage";
  stage: "COMPILING" | "EXTRACTING" | "INDEXING" | "VALIDATING";
  state: "start" | "finish" | "fail" | "cancel";
  elapsedMs?: number;
}

export interface WorkerProgress extends WorkerBase {
  type: "progress";
  stage: string;
  counts: Record<string, number>;
  elapsedMs: number;
}

export interface WorkerDiagnosticMessage extends WorkerBase {
  type: "diagnostic";
  diagnostic: BuildDiagnostic;
}

export interface WorkerArtifactReady extends WorkerBase {
  type: "artifact.ready";
  manifestPath: string;
  manifestSha256: string;
  snapshotId: string;
  counts: Record<string, number>;
  capabilities: Record<string, CapabilityStatus>;
}

export interface WorkerFailed extends WorkerBase {
  type: "failed";
  error: { code: string; message: string; retryable: boolean };
}

export interface WorkerCancelled extends WorkerBase {
  type: "cancelled";
}

export type WorkerMessage =
  | WorkerHello
  | WorkerStage
  | WorkerProgress
  | WorkerDiagnosticMessage
  | WorkerArtifactReady
  | WorkerFailed
  | WorkerCancelled;

export interface SnapshotSource {
  sourceId: string;
  displayPath: string;
  sha256: string;
  bytes: number;
  encoding?: string;
}

export interface SnapshotManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  protocolVersion: typeof PROTOCOL_VERSION;
  extractorVersion: string;
  compilerVersion: string;
  compilerCommit: string;
  snapshotId: string;
  projectId: string;
  jobId: string;
  createdAt: string;
  configDigest: string;
  rootInstanceId: string;
  rootPath: string;
  topModule: string;
  capabilities: Capability[];
  capabilityComplete: Record<string, CapabilityStatus>;
  counts: Record<string, number> & {
    instances: number;
    symbols: number;
    occurrences: number;
    drivers: number;
    loads: number;
    sources: number;
  };
  sources: SnapshotSource[];
  indexSha256: string;
  status: "READY" | "COMPLETE";
}

export type BuildState =
  | "QUEUED"
  | "STARTING"
  | "COMPILING"
  | "EXTRACTING"
  | "INDEXING"
  | "VALIDATING"
  | "PUBLISHING"
  | "COMPLETE"
  | "FAILED"
  | "CANCELLED";

export interface BuildJobSummary {
  jobId: string;
  projectId: string;
  requestKey: string;
  configRevision: number;
  state: BuildState;
  compileStatus: "unknown" | "succeeded" | "failed";
  snapshotStatus: "none" | "building" | "complete" | "failed";
  snapshotId: string | null;
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  counts: Record<string, number>;
  diagnostics: { error: number; warning: number; note: number; info: number; truncated: boolean };
  purged?: boolean;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  projectRoot: string;
  configRevision: number;
  currentSnapshotId: string | null;
  currentSnapshotPath: string | null;
  activeJobId: string | null;
  updatedAt: string;
}

export interface SnapshotSummary {
  snapshotId: string;
  projectId: string;
  rootPath: string;
  topModule: string;
  compilerVersion: string;
  createdAt: string;
  counts: Record<string, number>;
  capabilities: Capability[];
}

export interface InstanceNode {
  id: string;
  parentId: string | null;
  ordinal: number;
  name: string;
  moduleName: string;
  kind: "instance" | "generate" | "generate_array" | "generate_iter";
  path: string;
  sourceId: string | null;
  line: number | null;
  definitionSourceId: string | null;
  definitionLine: number | null;
  hasChildren: boolean;
  depth: number;
}

export interface HierarchyPage {
  records: InstanceNode[];
  nextCursor: string | null;
  complete: boolean;
  total: number | "unknown";
}

export interface SourceLine {
  line: number;
  text: string;
  startByte: number;
  endByte: number;
  /** False when the whole line lies outside the current instance's definition
   * or inside an inactive generate branch. */
  active: boolean;
}

export interface SourceRegion {
  startByte: number;
  endByte: number;
  kind: string;
  label: string | null;
}

export interface SemanticRef {
  occurrenceId: string;
  startByte: number;
  endByte: number;
  kind: string;
  role: string;
  status: "resolved" | "ambiguous" | "unresolved" | "unsupported" | "inactive";
  targetKind: string | null;
  targetId: string | null;
  targetSymbolKind: string | null;
  targetInstanceId: string | null;
  targetSourceId: string | null;
  targetStartByte: number | null;
  targetEndByte: number | null;
  targetLine: number | null;
  label: string | null;
}

export interface SourceWindow {
  snapshotId: string;
  sourceId: string;
  displayPath: string;
  language: string | null;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: SourceLine[];
  refs: SemanticRef[];
  /** Full source extent of the current instance's module/interface/program. */
  activeRegions: SourceRegion[];
  /** Branches that are not instantiated in this instance (generate if/case/loop). */
  inactiveRegions: SourceRegion[];
  truncated: boolean;
  complete: boolean;
  nextLine: number | null;
}

export interface ResolveResult {
  status: "resolved" | "ambiguous" | "unresolved" | "unsupported" | "inactive";
  occurrenceId: string | null;
  kind: string | null;
  role: string | null;
  targetKind: string | null;
  targetId: string | null;
  targetSymbolKind: string | null;
  targetInstanceId: string | null;
  targetSourceId: string | null;
  targetLine: number | null;
  label: string | null;
  message: string | null;
}

export interface SymbolDefinition {
  status: "resolved" | "unsupported";
  sourceId: string | null;
  startByte: number | null;
  endByte: number | null;
  line: number | null;
  label: string | null;
  kind: string | null;
  message: string | null;
}

export interface HoverInfo {
  status: ResolveResult["status"];
  title: string;
  declaration: string | null;
  sourceLine: string | null;
  kind: string | null;
  typeText: string | null;
  width: number | null;
  signed: boolean | null;
  packedDims: string | null;
  unpackedDims: string | null;
  direction: string | null;
  defaultValue: string | null;
  actualValue: string | null;
  macroBody: string | null;
  targetInstanceId: string | null;
  targetSourceId: string | null;
  targetLine: number | null;
  message: string | null;
}

export interface DriverRecord {
  id: string;
  kind: string;
  sourceKind: string | null;
  targetInstanceId: string | null;
  targetSymbolId: string;
  targetBitLo: number | null;
  targetBitHi: number | null;
  sourceInstanceId: string | null;
  sourceSymbolId: string | null;
  sourceBitLo: number | null;
  sourceBitHi: number | null;
  sourceId: string | null;
  startByte: number | null;
  endByte: number | null;
  line: number | null;
  exactness: "exact" | "inexact" | "unsupported";
  detail: string | null;
  targetLabel: string | null;
}

export interface DriverPage {
  traceId: string;
  snapshotId: string;
  direction: "driver";
  originInstanceId: string;
  originSymbolId: string;
  bitSelection: string | null;
  records: DriverRecord[];
  nextCursor: string | null;
  complete: boolean;
  total: number | "unknown";
  status: "resolved" | "no-driver" | "declaration-fallback" | "ambiguous" | "unsupported" | "analysis-failed";
  message: string | null;
}

export interface LoadRecord {
  id: string;
  role: "data" | "control" | "event" | "port" | "other";
  exactness: "exact" | "inexact" | "unsupported";
  sourceInstanceId: string | null;
  sourceSymbolId: string;
  sourceBitLo: number | null;
  sourceBitHi: number | null;
  targetInstanceId: string | null;
  targetSymbolId: string;
  targetBitLo: number | null;
  targetBitHi: number | null;
  useSourceId: string | null;
  useStartByte: number | null;
  useEndByte: number | null;
  targetSourceId: string | null;
  targetStartByte: number | null;
  targetEndByte: number | null;
  targetLabel: string | null;
  detail: string | null;
}

export interface LoadPage {
  traceId: string;
  snapshotId: string;
  direction: "load";
  originInstanceId: string;
  originSymbolId: string;
  bitSelection: string | null;
  records: LoadRecord[];
  nextCursor: string | null;
  complete: boolean;
  total: number | "unknown";
  status: "resolved" | "no-load" | "ambiguous" | "unsupported" | "analysis-failed";
  message: string | null;
}

export interface InspectorPort {
  symbolId: string;
  name: string;
  direction: string;
  typeText: string;
  width: number | null;
  line: number | null;
}

export interface InspectorParam {
  symbolId: string;
  name: string;
  kind: string;
  typeText: string;
  defaultValue: string | null;
  actualValue: string | null;
  width: number | null;
  line: number | null;
}

export interface InspectorPage {
  tab: "ports" | "params" | "children";
  records: Array<InspectorPort | InspectorParam | InstanceNode>;
  nextCursor: string | null;
  complete: boolean;
  total: number | "unknown";
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number | null;
  readable: boolean;
}

export interface FsListing {
  rootId: string;
  path: string;
  parentPath: string | null;
  entries: FsEntry[];
  truncated: boolean;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
