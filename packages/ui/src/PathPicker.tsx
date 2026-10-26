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

import React, { useEffect, useState } from "react";
import type { FsEntry } from "../../contracts/src/types.js";
import type { RtlClient } from "../../client/src/api.js";

interface Props {
  client: RtlClient;
  mode: "file" | "directory";
  onPick: (path: string) => void;
  onClose: () => void;
}

export function PathPicker({ client, mode, onPick, onClose }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(p: string | null) {
    setError(null);
    try {
      const listing = await client.paths(p);
      setPath(listing.path || null);
      setParentPath(listing.parentPath ?? null);
      setEntries(listing.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void load(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal path-picker" role="dialog" aria-label="选择路径">
        <div className="modal-head">
          <strong>选择{mode === "file" ? "文件" : "目录"}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="path-current">{path ?? "授权根目录"}</div>
        {error && <div className="form-error">{error}</div>}
        <div className="path-list">
          {path && parentPath && (
            <button className="path-row" onClick={() => void load(parentPath)}>
              <span>..</span><span className="muted">上一级</span>
            </button>
          )}
          {entries.map((e) => (
            <button
              key={e.path}
              className={`path-row${e.kind === "directory" ? " dir" : ""}`}
              onClick={() => (e.kind === "directory" ? void load(e.path) : onPick(e.path))}
              title={e.path}
            >
              <span>{e.kind === "directory" ? "▸ " : "  "}{e.name}</span>
              <span className="muted">{e.kind}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          {mode === "directory" && path && <button className="primary" onClick={() => onPick(path)}>选择当前目录</button>}
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
