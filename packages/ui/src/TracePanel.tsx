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

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DriverPage, DriverRecord, LoadPage, LoadRecord } from "../../contracts/src/types.js";
import { SearchBox } from "./SearchBox.js";

interface Props {
  trace: DriverPage | LoadPage | null;
  loading: boolean;
  error: string | null;
  onJump: (record: DriverRecord | LoadRecord) => void;
  onMore: () => void;
}

function bits(lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return "";
  return lo === hi ? `[${lo}]` : `[${hi}:${lo}]`;
}

function traceText(r: DriverRecord | LoadRecord): string {
  const isLoad = "role" in r;
  return [
    isLoad ? r.role : r.kind,
    r.targetLabel ?? "",
    r.targetSymbolId,
    isLoad ? r.detail ?? "" : r.sourceKind ?? "",
    r.exactness,
    isLoad ? r.targetStartByte ?? "" : r.line ?? "",
  ].join("\n").toLowerCase();
}

export function TracePanel({ trace, loading, error, onJump, onMore }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const needle = query.trim().toLowerCase();
  const records = trace?.records ?? [];
  const matches = useMemo(
    () => needle ? records.filter((r) => traceText(r).includes(needle)) : [],
    [needle, records],
  );

  useEffect(() => { setIndex(0); }, [needle, trace?.traceId]);
  useEffect(() => {
    if (matches.length === 0) { setIndex(0); return; }
    if (index >= matches.length) setIndex(0);
  }, [matches.length, index]);
  useEffect(() => {
    if (matches.length === 0) return;
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(matches[Math.min(index, matches.length - 1)].id)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [index, matches]);

  if (!trace) return <div className="panel-empty">右键信号选择 Driver 或 Load，结果会显示在这里。</div>;
  const direction = trace.direction === "driver" ? "来源" : "目的端";
  return (
    <div className="trace-panel">
      <div className="trace-head">
        <span className={`dir-badge dir-${trace.direction}`}>{direction}</span>
        <span className="mono">{trace.traceId}</span>
        <span className="muted">snapshot {trace.snapshotId}</span>
        <span className="muted">共 {trace.total === "unknown" ? "未知" : trace.total} 条</span>
        {loading && <span className="muted">查询中…</span>}
        <span className="spacer" />
        <SearchBox
          value={query}
          onChange={setQuery}
          onNext={() => setIndex((i) => matches.length ? (i + 1) % matches.length : 0)}
          onPrev={() => setIndex((i) => matches.length ? (i - 1 + matches.length) % matches.length : 0)}
          index={index}
          total={matches.length}
          placeholder="搜索 Trace…"
          title="在 Driver/Load 记录中搜索"
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      {trace.status !== "resolved" && <div className="panel-empty">{trace.message ?? trace.status}</div>}
      {trace.status === "resolved" && trace.records.length === 0 && <div className="panel-empty">无结果</div>}
      <div className="trace-list">
        {trace.records.map((r) => {
          const isLoad = "role" in r;
          const label = r.targetLabel ?? r.targetSymbolId;
          const line = isLoad ? r.targetStartByte : r.line;
          return (
            <button
              ref={(el) => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id); }}
              className={`trace-row${needle && matches.includes(r) ? " search-hit" : ""}${matches[index]?.id === r.id ? " search-current" : ""}`}
              key={`${trace.direction}-${r.id}`}
              onClick={() => onJump(r)}
            >
              <span className={`role role-${isLoad ? r.role : r.kind}`}>{isLoad ? r.role : r.kind}</span>
              <span className="trace-target">{label}{bits(r.targetBitLo, r.targetBitHi)}</span>
              <span className="muted">{isLoad ? r.detail : r.sourceKind}</span>
              <span className={`exact exact-${r.exactness}`}>{r.exactness === "exact" ? "精确" : r.exactness === "inexact" ? "不精确" : "不支持"}</span>
              <span className="muted">byte {line ?? "?"}</span>
            </button>
          );
        })}
      </div>
      {!trace.complete && (
        <button className="panel-more" onClick={onMore} disabled={loading}>加载更多</button>
      )}
    </div>
  );
}
