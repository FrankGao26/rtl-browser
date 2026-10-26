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
import type { InstanceNode, InspectorParam, InspectorPort } from "../../contracts/src/types.js";
import { SearchBox } from "./SearchBox.js";

interface Props {
  instance: InstanceNode | null;
  tab: "ports" | "params";
  onTab: (tab: "ports" | "params") => void;
  ports: InspectorPort[];
  params: InspectorParam[];
  loading: boolean;
  error: string | null;
  onSelect: (symbolId: string) => void;
}

function portText(p: InspectorPort): string {
  return `${p.name}\n${p.direction}\n${p.typeText}\n${p.width ?? ""}`.toLowerCase();
}
function paramText(p: InspectorParam): string {
  return `${p.name}\n${p.kind}\n${p.typeText}\n${p.defaultValue ?? ""}\n${p.actualValue ?? ""}\n${p.width ?? ""}`.toLowerCase();
}

export function InspectorPanel({ instance, tab, onTab, ports, params, loading, error, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    return tab === "ports"
      ? ports.filter((p) => portText(p).includes(needle)).map((p) => p.symbolId)
      : params.filter((p) => paramText(p).includes(needle)).map((p) => p.symbolId);
  }, [needle, tab, ports, params]);
  const searchable = !!instance && instance.kind === "instance";

  useEffect(() => { setIndex(0); }, [needle, tab, instance?.id]);
  useEffect(() => {
    if (matches.length === 0) { setIndex(0); return; }
    if (index >= matches.length) setIndex(0);
  }, [matches.length, index]);
  useEffect(() => {
    if (matches.length === 0) return;
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(matches[Math.min(index, matches.length - 1)])?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [index, matches]);

  return (
    <section className="inspector-panel">
      <div className="pane-title">Inspector</div>
      <div className="pane-search-row">
        <SearchBox
          value={query}
          onChange={setQuery}
          onNext={() => setIndex((i) => matches.length ? (i + 1) % matches.length : 0)}
          onPrev={() => setIndex((i) => matches.length ? (i - 1 + matches.length) % matches.length : 0)}
          index={index}
          total={matches.length}
          placeholder="搜索端口/参数…"
          disabled={!searchable}
          title={searchable ? "搜索当前 Inspector 列表" : "选择一个模块实例后可搜索"}
        />
      </div>
      {!instance ? <div className="panel-empty">选择一个实例。</div> : (
        <>
          <div className="inspector-instance">
            <div className="inst-name">{instance.name}</div>
            <div className="mono muted">{instance.path}</div>
            <div className="muted">
              {instance.kind === "instance" ? `模块 ${instance.moduleName}` : "生成层次"}
            </div>
          </div>
          {instance.kind !== "instance" ? (
            <div className="panel-empty">
              生成层次没有端口/参数页。源码中的 Driver/Load 按所属模块 body 查询，因此同模块内其他 generate 作用域的信号也可用；Trace 会标明每条边的实际实例。
            </div>
          ) : (
            <>
              <div className="tabs small">
                <button className={tab === "ports" ? "active" : ""} onClick={() => onTab("ports")}>端口</button>
                <button className={tab === "params" ? "active" : ""} onClick={() => onTab("params")}>参数</button>
              </div>
              {loading && <div className="muted">加载中…</div>}
              {error && <div className="form-error">{error}</div>}
              <div className="inspector-list">
                {tab === "ports" && ports.map((p) => (
                  <button
                    type="button"
                    ref={(el) => { if (el) rowRefs.current.set(p.symbolId, el); else rowRefs.current.delete(p.symbolId); }}
                    className={`inspector-row inspector-row-port${needle && matches.includes(p.symbolId) ? " search-hit" : ""}${matches[index] === p.symbolId ? " search-current" : ""}`}
                    key={p.symbolId}
                    onClick={() => onSelect(p.symbolId)}
                    title={`跳到端口 ${p.name} 的定义位置`}
                  >
                    <span className={`dir dir-${p.direction}`}>{p.direction}</span>
                    <span className="mono port-name">{p.name}</span>
                    <span className="muted port-type" title={p.typeText}>{p.typeText}{p.width !== null ? ` · ${p.width}b` : ""}</span>
                  </button>
                ))}
                {tab === "params" && params.map((p) => (
                  <button
                    type="button"
                    ref={(el) => { if (el) rowRefs.current.set(p.symbolId, el); else rowRefs.current.delete(p.symbolId); }}
                    className={`inspector-row inspector-row-param${needle && matches.includes(p.symbolId) ? " search-hit" : ""}${matches[index] === p.symbolId ? " search-current" : ""}`}
                    key={p.symbolId}
                    onClick={() => onSelect(p.symbolId)}
                    title={`跳到${p.kind === "type_parameter" ? "类型参数" : "参数"} ${p.name} 的定义位置`}
                  >
                    <span className="mono param-name">{p.name}</span>
                    <span className="param-kind">{p.kind === "type_parameter" ? "type parameter" : p.kind}</span>
                    <span className="muted param-type" title={p.typeText}>{p.typeText || "—"}</span>
                    <span className="param-value" title={p.defaultValue ?? "—"}>
                      <span className="param-label">默认</span><span className="mono">{p.defaultValue ?? "—"}</span>
                    </span>
                    <span className="param-value" title={p.actualValue ?? "—"}>
                      <span className="param-label">实际</span><span className="mono">{p.actualValue ?? "—"}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
