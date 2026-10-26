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

export interface NavTarget {
  projectId: string;
  snapshotId: string;
  instanceId?: string | null;
  sourceId?: string | null;
  line?: number | null;
  byteOffset?: number | null;
  tokenStart?: number | null;
  tokenEnd?: number | null;
  scrollRatio?: number | null;
  label?: string | null;
}

export function targetToUrl(t: NavTarget): string {
  const q = new URLSearchParams();
  q.set("project", t.projectId);
  q.set("snapshot", t.snapshotId);
  if (t.instanceId) q.set("instance", t.instanceId);
  if (t.sourceId) q.set("source", t.sourceId);
  if (t.line) q.set("line", String(t.line));
  if (t.byteOffset !== null && t.byteOffset !== undefined) q.set("byte", String(t.byteOffset));
  if (t.tokenStart !== null && t.tokenStart !== undefined) q.set("ts", String(t.tokenStart));
  if (t.tokenEnd !== null && t.tokenEnd !== undefined) q.set("te", String(t.tokenEnd));
  if (t.scrollRatio !== null && t.scrollRatio !== undefined) {
    q.set("scroll", String(Math.round(Math.max(0, Math.min(1, t.scrollRatio)) * 10000)));
  }
  // Package-level targets have no instance hierarchy; keep the package name
  // so copy-hierarchy and reloads retain the source context.
  if (t.label) q.set("ctx", t.label);
  return `${location.pathname}?${q.toString()}`;
}

function num(q: URLSearchParams, key: string): number | null {
  const v = q.get(key);
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function urlToTarget(search = location.search): NavTarget | null {
  const q = new URLSearchParams(search);
  const projectId = q.get("project");
  const snapshotId = q.get("snapshot");
  if (!projectId || !snapshotId) return null;
  return {
    projectId,
    snapshotId,
    instanceId: q.get("instance"),
    sourceId: q.get("source"),
    line: num(q, "line"),
    byteOffset: num(q, "byte"),
    tokenStart: num(q, "ts"),
    tokenEnd: num(q, "te"),
    scrollRatio: num(q, "scroll") === null ? null : (num(q, "scroll") as number) / 10000,
    label: q.get("ctx"),
  };
}

export function cleanUrlWithoutToken(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
