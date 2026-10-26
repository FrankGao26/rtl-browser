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

export const LIMITS = {
  maxRequestBytes: 65_536,
  maxResponseBytes: 1_048_576,
  // Source windows contain both text and per-token occurrence metadata for
  // large generated modules; keep the generic JSON cap but allow this one
  // response type a larger budget.
  maxSourceResponseBytes: 8_388_608,
  maxSourceWindowBytes: 262_144,
  defaultPageSize: 200,
  maxPageSize: 1_000,
  queryQueueDepth: 32,
  queryTimeoutMs: 1_000,
  sourceSearchTimeoutMs: 10_000,
  maxDiagnostics: 10_000,
  maxLogBytes: 2_097_152,
  maxWorkerFrameBytes: 1_048_576,
  maxSourceFileBytes: 268_435_456,
  maxSnapshotBundleBytes: 8_589_934_592,
  maxSnapshotBundleHeaderBytes: 16_777_216,
  maxSnapshotBundleEntries: 100_000,
} as const;

export function clampPageSize(input: unknown): number {
  const n = typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : LIMITS.defaultPageSize;
  return Math.min(LIMITS.maxPageSize, Math.max(1, n));
}
