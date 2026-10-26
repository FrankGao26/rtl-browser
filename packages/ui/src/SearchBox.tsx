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

import React from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  index: number;
  total: number;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
}

export function SearchBox({ value, onChange, onNext, onPrev, index, total, placeholder = "搜索…", disabled = false, title }: Props) {
  const hasMatches = total > 0;
  return (
    <div className={`search-box${disabled ? " disabled" : ""}`} title={title}>
      <span className="search-icon" aria-hidden="true">⌕</span>
      <input
        className="search-input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onChange("");
            e.currentTarget.blur();
          }
        }}
      />
      {value && <span className="search-count" aria-live="polite">{hasMatches ? `${Math.min(index + 1, total)}/${total}` : "0/0"}</span>}
      <button className="search-step" onClick={onPrev} disabled={!hasMatches} title="上一个匹配 (Shift+Enter)" aria-label="上一个匹配">↑</button>
      <button className="search-step" onClick={onNext} disabled={!hasMatches} title="下一个匹配 (Enter)" aria-label="下一个匹配">↓</button>
    </div>
  );
}
