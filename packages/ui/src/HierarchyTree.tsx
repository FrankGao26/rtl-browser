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

import React, { useEffect, useRef, useState } from "react";
import type { InstanceNode } from "../../contracts/src/types.js";
import type { RtlClient } from "../../client/src/api.js";

interface Props {
  client: RtlClient;
  projectId: string;
  snapshotId: string;
  selectedId: string | null;
  revealPath: InstanceNode[];
  searchMatchIds?: Set<string>;
  resetToken?: number;
  onSelect: (node: InstanceNode) => void;
  onRoot: (node: InstanceNode | null) => void;
}

interface Level {
  records: InstanceNode[];
  nextCursor: string | null;
  complete: boolean;
  loading: boolean;
}

export function HierarchyTree({ client, projectId, snapshotId, selectedId, revealPath, searchMatchIds, resetToken = 0, onSelect, onRoot }: Props) {
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selectedRow = useRef<HTMLDivElement | null>(null);

  async function loadLevel(parentId: string | null, append = false) {
    const key = parentId ?? "$root";
    const prev = levels[key];
    if (prev?.loading) return;
    setLevels((s) => ({ ...s, [key]: { records: append ? prev?.records ?? [] : [], nextCursor: prev?.nextCursor ?? null, complete: prev?.complete ?? false, loading: true } }));
    try {
      const page = await client.children(projectId, snapshotId, parentId, append ? prev?.nextCursor ?? null : null, 200);
      setLevels((s) => {
        const old = s[key];
        const records = append ? [...(old?.records ?? []), ...page.records] : page.records;
        return { ...s, [key]: { records, nextCursor: page.nextCursor, complete: page.complete, loading: false } };
      });
      if (parentId === null) onRoot(page.records[0] ?? null);
    } catch {
      setLevels((s) => ({ ...s, [key]: { ...(s[key] ?? { records: [], nextCursor: null, complete: false }), loading: false } }));
    }
  }

  useEffect(() => {
    setLevels({});
    setExpanded(new Set());
    void loadLevel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, snapshotId, resetToken]);

  useEffect(() => {
    if (revealPath.length === 0) return;
    (async () => {
      for (const node of revealPath.slice(0, -1)) {
        if (!levels[node.id]) await loadLevel(node.id);
        setExpanded((s) => new Set(s).add(node.id));
      }
      const leafParent = revealPath.length > 1 ? revealPath[revealPath.length - 2].id : null;
      if (!levels[leafParent ?? "$root"]) await loadLevel(leafParent);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath]);

  useEffect(() => {
    if (!selectedId) return;
    const frame = requestAnimationFrame(() => selectedRow.current?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [selectedId, levels, expanded, revealPath]);

  function toggle(node: InstanceNode) {
    if (!node.hasChildren) return;
    if (!levels[node.id]) void loadLevel(node.id);
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(node.id)) n.delete(node.id);
      else n.add(node.id);
      return n;
    });
  }

  function renderNodes(parentKey: string, depth: number): React.ReactNode {
    const level = levels[parentKey];
    if (!level) return <div className="tree-empty">加载中…</div>;
    return (
      <>
        {level.records.map((node) => (
          <div key={node.id}>
            <div
              ref={(el) => { if (node.id === selectedId) selectedRow.current = el; }}
              className={`tree-row tree-${node.kind}${selectedId === node.id ? " selected" : ""}${searchMatchIds?.has(node.id) ? " tree-match" : ""}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => onSelect(node)}
              title={node.path}
            >
              <button
                className={`tree-toggle${node.hasChildren ? "" : " invisible"}`}
                onClick={(e) => { e.stopPropagation(); toggle(node); }}
                aria-label={expanded.has(node.id) ? "折叠" : "展开"}
              >
                {expanded.has(node.id) ? "▾" : "▸"}
              </button>
              <span className="tree-name">{node.name}</span>
              <span className="tree-module">
                {node.kind === "instance" ? node.moduleName :
                  node.kind === "generate_array" ? "generate/for" :
                    node.kind === "generate_iter" ? "iteration" : "generate"}
              </span>
            </div>
            {expanded.has(node.id) && renderNodes(node.id, depth + 1)}
          </div>
        ))}
        {!level.complete && (
          <button className="tree-more" onClick={() => void loadLevel(parentKey === "$root" ? null : parentKey, true)}>
            {level.loading ? "加载中…" : "加载更多"}
          </button>
        )}
      </>
    );
  }

  return <div className="hierarchy-tree">{renderNodes("$root", 0)}</div>;
}
