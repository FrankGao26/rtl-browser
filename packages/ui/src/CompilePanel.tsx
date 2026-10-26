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
import type { BuildDiagnostic, BuildJobSummary } from "../../contracts/src/types.js";
import { SearchBox } from "./SearchBox.js";

interface Props {
  jobs: BuildJobSummary[];
  selectedJobId: string | null;
  diagnostics: BuildDiagnostic[];
  filterSeverity: string;
  filterStage: string;
  loading: boolean;
  canJump: boolean;
  onSelectJob: (jobId: string) => void;
  onFilterSeverity: (s: string) => void;
  onFilterStage: (s: string) => void;
  onCancel: () => void;
  onJump: (d: BuildDiagnostic) => void;
  onMore: () => void;
  hasMore: boolean;
}

const SEVERITY_LABEL: Record<string, string> = { error: "错误", warning: "警告", note: "备注", info: "信息" };

function diagnosticText(d: BuildDiagnostic): string {
  return [
    d.severity,
    d.stage,
    d.code,
    d.message,
    d.primaryLocation?.displayPath ?? "",
    ...(d.relatedNotes ?? []).map((n) => n.message),
  ].join("\n").toLowerCase();
}

export function CompilePanel(props: Props) {
  const job = props.jobs.find((j) => j.jobId === props.selectedJobId) ?? null;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => needle ? props.diagnostics.filter((d) => diagnosticText(d).includes(needle)) : [],
    [needle, props.diagnostics],
  );

  useEffect(() => {
    setIndex(0);
  }, [needle, props.filterSeverity, props.filterStage, props.selectedJobId]);

  useEffect(() => {
    if (matches.length === 0) {
      setIndex(0);
      return;
    }
    if (index >= matches.length) setIndex(0);
  }, [matches.length, index]);

  useEffect(() => {
    if (matches.length === 0) return;
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(matches[Math.min(index, matches.length - 1)].sequence)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [index, matches]);

  return (
    <div className="compile-panel">
      <div className="compile-head">
        <div className="job-list">
          {props.jobs.length === 0 && <span className="muted">暂无构建任务</span>}
          {props.jobs.map((j) => (
            <button
              key={j.jobId}
              className={`job-chip${j.jobId === props.selectedJobId ? " active" : ""}`}
              onClick={() => props.onSelectJob(j.jobId)}
              title={j.jobId}
            >
              <span>{j.jobId.slice(0, 8)}</span>
              <span className={`state state-${j.state.toLowerCase()}`}>{j.state}</span>
            </button>
          ))}
        </div>
        {(job?.state === "COMPILING" || job?.state === "STARTING" || job?.state === "EXTRACTING" || job?.state === "INDEXING" || job?.state === "VALIDATING" || job?.state === "PUBLISHING" || job?.state === "QUEUED") && (
          <button onClick={props.onCancel}>取消构建</button>
        )}
      </div>
      {job && (
        <div className="compile-summary">
          <span className={`state state-${job.state.toLowerCase()}`}>{job.state}</span>
          <span>阶段 {job.stage}</span>
          <span>error {job.diagnostics.error}</span>
          <span>warning {job.diagnostics.warning}</span>
          <span>note {job.diagnostics.note}</span>
          <span className="muted">compile={job.compileStatus} snapshot={job.snapshotStatus}</span>
          {job.error && <span className="form-error">{job.error.code}: {job.error.message}</span>}
          {job.diagnostics.truncated && <span className="warn-text">诊断已截断</span>}
        </div>
      )}
      <div className="compile-filters">
        <label>级别
          <select value={props.filterSeverity} onChange={(e) => props.onFilterSeverity(e.target.value)}>
            <option value="">全部</option>
            <option value="error">error</option>
            <option value="warning">warning</option>
            <option value="note">note</option>
            <option value="info">info</option>
          </select>
        </label>
        <label>阶段
          <select value={props.filterStage} onChange={(e) => props.onFilterStage(e.target.value)}>
            <option value="">全部</option>
            <option value="COMPILING">COMPILING</option>
            <option value="EXTRACTING">EXTRACTING</option>
            <option value="INDEXING">INDEXING</option>
            <option value="VALIDATING">VALIDATING</option>
            <option value="PUBLISHING">PUBLISHING</option>
          </select>
        </label>
        {props.loading && <span className="muted">加载中…</span>}
        <span className="spacer" />
        <SearchBox
          value={query}
          onChange={setQuery}
          onNext={() => setIndex((i) => matches.length ? (i + 1) % matches.length : 0)}
          onPrev={() => setIndex((i) => matches.length ? (i - 1 + matches.length) % matches.length : 0)}
          index={index}
          total={matches.length}
          placeholder="搜索诊断…"
          title={props.hasMore ? "仅搜索当前已加载的诊断；点击“加载更多诊断”可继续搜索" : "在诊断消息、代码、阶段和文件路径中搜索"}
        />
      </div>
      <div className="diagnostic-list">
        {props.diagnostics.length === 0 && <div className="panel-empty">没有符合条件的诊断</div>}
        {props.diagnostics.map((d) => (
          <div
            ref={(el) => { if (el) rowRefs.current.set(d.sequence, el); else rowRefs.current.delete(d.sequence); }}
            className={`diag diag-${d.severity}${needle && matches.includes(d) ? " search-hit" : ""}${matches[index]?.sequence === d.sequence ? " search-current" : ""}`}
            key={d.sequence}
          >
            <span className={`sev sev-${d.severity}`}>{SEVERITY_LABEL[d.severity] ?? d.severity}</span>
            <span className="diag-code mono">{d.code}</span>
            <span className="diag-msg">{d.message}</span>
            {d.primaryLocation && (
              <button
                className="diag-loc mono"
                disabled={!props.canJump}
                title={props.canJump ? "跳转到该成功快照的源码" : "失败/未发布任务只能查看位置文本"}
                onClick={() => props.onJump(d)}
              >
                {d.primaryLocation.displayPath}:{d.primaryLocation.line}:{d.primaryLocation.column}
              </button>
            )}
            {d.relatedNotes?.map((n, i) => <div className="diag-note" key={i}>↳ {n.message}</div>)}
          </div>
        ))}
      </div>
      {props.hasMore && <button className="panel-more" onClick={props.onMore} disabled={props.loading}>加载更多诊断</button>}
    </div>
  );
}
