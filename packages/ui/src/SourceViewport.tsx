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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SemanticRef, SourceLine, SourceRegion, SourceWindow } from "../../contracts/src/types.js";
import { lexSvLine, type SvLexState, type SvToken } from "./svLexer.js";

export interface SourceHighlight {
  sourceId: string;
  startByte: number;
  endByte: number;
}

interface Props {
  window: SourceWindow;
  highlight?: SourceHighlight | null;
  onRefHover: (ref: SemanticRef | null, event?: React.MouseEvent) => void;
  onRefContext: (ref: SemanticRef, event: React.MouseEvent) => void;
  onRefClick: (ref: SemanticRef) => void;
  onScrollRatio: (ratio: number) => void;
  restoreScrollRatio?: number | null;
  layoutKey?: string;
  searchLines?: Set<number>;
  searchLine?: number | null;
  searchQuery?: string;
}

interface Segment {
  start: number;
  end: number;
  cls: string;
  ref: SemanticRef | null;
  highlighted: boolean;
  searchText: boolean;
  inactive: boolean;
}

interface TextRange {
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchRangesFor(text: string, needle: string): TextRange[] {
  if (!needle) return [];
  const re = new RegExp(escapeRegExp(needle), "gi");
  const out: TextRange[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (match[0].length > 0) out.push({ start, end: start + match[0].length });
  }
  return out;
}

function byteToChar(text: string, byteRel: number): number {
  if (byteRel <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) ?? 0;
    const n = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + n > byteRel) return i;
    bytes += n;
    if (cp > 0xffff) i++;
  }
  return text.length;
}

function refsForLine(refs: SemanticRef[], line: SourceLine, text: string): Array<{ start: number; end: number; ref: SemanticRef }> {
  const out: Array<{ start: number; end: number; ref: SemanticRef }> = [];
  const lineStart = line.startByte;
  const lineEnd = line.endByte;
  for (const ref of refs) {
    if (ref.endByte <= lineStart || ref.startByte >= lineEnd) continue;
    const start = byteToChar(text, Math.max(0, ref.startByte - lineStart));
    const end = byteToChar(text, Math.max(0, ref.endByte - lineStart));
    if (end > start) out.push({ start, end, ref });
  }
  return out;
}

function regionRangesForLine(regions: SourceRegion[], line: SourceLine, text: string): TextRange[] {
  const out: TextRange[] = [];
  for (const region of regions) {
    if (region.endByte <= line.startByte || region.startByte >= line.endByte) continue;
    const start = byteToChar(text, Math.max(0, region.startByte - line.startByte));
    const end = byteToChar(text, Math.min(line.endByte - line.startByte, region.endByte - line.startByte));
    if (end > start) out.push({ start, end });
  }
  return out;
}

function segmentsFor(
  line: SourceLine,
  tokens: SvToken[],
  refs: SemanticRef[],
  highlight: SourceHighlight | null,
  sourceId: string,
  searchRanges: TextRange[],
  activeRegions: SourceRegion[],
  inactiveRegions: SourceRegion[],
): Segment[] {
  const text = line.text;
  const localRefs = refsForLine(refs, line, text);
  const activeLocal = regionRangesForLine(activeRegions, line, text);
  const inactiveLocal = regionRangesForLine(inactiveRegions, line, text);
  const boundaries = new Set<number>([0, text.length]);
  for (const t of tokens) { boundaries.add(t.start); boundaries.add(t.end); }
  for (const r of localRefs) { boundaries.add(r.start); boundaries.add(r.end); }
  for (const r of searchRanges) { boundaries.add(r.start); boundaries.add(r.end); }
  for (const r of activeLocal) { boundaries.add(r.start); boundaries.add(r.end); }
  for (const r of inactiveLocal) { boundaries.add(r.start); boundaries.add(r.end); }
  if (highlight && highlight.sourceId === sourceId) {
    boundaries.add(byteToChar(text, Math.max(0, highlight.startByte - line.startByte)));
    boundaries.add(byteToChar(text, Math.max(0, highlight.endByte - line.startByte)));
  }
  const points = [...boundaries].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const token = tokens.find((t) => t.start <= start && t.end >= end);
    const inActive = activeLocal.length === 0 ||
      activeLocal.some((r) => r.start <= start && r.end >= end);
    const inInactive = inactiveLocal.some((r) => r.start <= start && r.end >= end);
    const inactive = !inActive || inInactive;
    let ref: SemanticRef | null = null;
    if (!inactive) {
      for (const r of localRefs) {
        if (r.start <= start && r.end >= end) {
          if (!ref || (r.end - r.start) < (ref.endByte - ref.startByte)) ref = r.ref;
        }
      }
    }
    const highlighted = !inactive && !!highlight && highlight.sourceId === sourceId &&
      highlight.startByte < line.startByte + end && highlight.endByte > line.startByte + start;
    const searchText = !inactive && searchRanges.some((r) => r.start < end && r.end > start);
    segments.push({ start, end, cls: token?.cls ?? "identifier", ref, highlighted, searchText, inactive });
  }
  return segments;
}

export function SourceViewport(props: Props) {
  const { window: win, highlight, onRefHover, onRefContext, onRefClick } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [lineHeight, setLineHeight] = useState(20);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);
  const restored = useRef(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const probe = el.querySelector<HTMLElement>(".src-line");
      if (probe) setLineHeight(Math.max(12, probe.getBoundingClientRect().height));
      setViewHeight(el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [win.sourceId, props.layoutKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || restored.current) return;
    restored.current = true;
    if (props.restoreScrollRatio !== null && props.restoreScrollRatio !== undefined) {
      el.scrollTop = Math.max(0, props.restoreScrollRatio * Math.max(0, el.scrollHeight - el.clientHeight));
    }
  }, [win.sourceId, win.startLine, props.restoreScrollRatio]);

  useEffect(() => { restored.current = false; }, [win.sourceId, win.startLine]);

  useLayoutEffect(() => {
    if (props.restoreScrollRatio !== null && props.restoreScrollRatio !== undefined) return;
    if (!highlight) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = win.lines.findIndex((l) => highlight.startByte >= l.startByte && highlight.startByte < l.endByte);
    if (idx >= 0) el.scrollTop = Math.max(0, idx * lineHeight - el.clientHeight * 0.35);
  }, [highlight, win.sourceId, lineHeight, props.restoreScrollRatio]);

  useLayoutEffect(() => {
    if (props.searchLine === null || props.searchLine === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = win.lines.findIndex((l) => l.line === props.searchLine);
    if (idx >= 0) el.scrollTop = Math.max(0, idx * lineHeight - el.clientHeight * 0.35);
  }, [props.searchLine, win.sourceId, win.startLine, lineHeight]);

  const lexed = useMemo(() => {
    const state: SvLexState = { blockComment: false };
    const map = new Map<number, { tokens: SvToken[]; state: SvLexState }>();
    for (const line of win.lines) {
      const r = lexSvLine(line.text, state);
      map.set(line.line, { tokens: r.tokens, state: r.state });
      state.blockComment = r.state.blockComment;
    }
    return map;
  }, [win]);

  const searchMatches = useMemo(() => {
    const needle = props.searchQuery?.trim() ?? "";
    const map = new Map<number, TextRange[]>();
    if (!needle) return map;
    for (const line of win.lines) {
      const ranges = searchRangesFor(line.text, needle);
      if (ranges.length) map.set(line.line, ranges);
    }
    return map;
  }, [win, props.searchQuery]);

  const overscan = 24;
  const startIndex = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const endIndex = Math.min(win.lines.length, Math.ceil((scrollTop + viewHeight) / lineHeight) + overscan);
  const visible = win.lines.slice(startIndex, endIndex);
  const topPad = startIndex * lineHeight;
  const bottomPad = Math.max(0, (win.lines.length - endIndex) * lineHeight);

  return (
    <div
      className="source-viewport"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        const denom = Math.max(1, el.scrollHeight - el.clientHeight);
        props.onScrollRatio(Math.min(1, Math.max(0, el.scrollTop / denom)));
      }}
    >
      <div style={{ height: topPad }} />
      {visible.map((line) => {
        const { tokens } = lexed.get(line.line) ?? { tokens: [] };
        const segs = segmentsFor(
          line, tokens, win.refs, highlight ?? null, win.sourceId,
          searchMatches.get(line.line) ?? [], win.activeRegions, win.inactiveRegions,
        );
        const lineInactive = line.active === false;
        const lineHighlighted = !lineInactive && !!highlight && highlight.sourceId === win.sourceId &&
          highlight.startByte < line.endByte && highlight.endByte > line.startByte;
        const searchHit = !lineInactive && !!props.searchLines?.has(line.line);
        const searchCurrent = !lineInactive && props.searchLine === line.line;
        return (
          <div
            className={`src-line${lineInactive ? " src-line-inactive" : ""}${lineHighlighted ? " src-line-hl" : ""}${searchHit ? " src-line-search" : ""}${searchCurrent ? " src-line-search-current" : ""}`}
            data-line={line.line}
            key={line.line}
          >
            <span className="src-ln">{line.line}</span>
            <span className="src-code">
              {segs.map((s, i) => {
                const text = line.text.slice(s.start, s.end);
                const searchCls = s.searchText ? " src-search-text" : "";
                const inactiveCls = s.inactive ? " src-inactive" : "";
                if (!s.ref) return <span key={i} className={`tok-${s.cls}${s.highlighted ? " token-hl" : ""}${searchCls}${inactiveCls}`}>{text}</span>;
                const target = s.ref;
                return (
                  <span
                    key={i}
                    className={`tok-${s.cls} sem sem-${target.status}${s.highlighted ? " sem-hl token-hl" : ""}${target.role === "declaration" ? " sem-decl" : ""}${searchCls}${inactiveCls}`}
                    onMouseEnter={(e) => onRefHover(target, e)}
                    onMouseLeave={() => onRefHover(null)}
                    onClick={(e) => { e.stopPropagation(); onRefClick(target); }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRefContext(target, e); }}
                  >
                    {text}
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
      <div style={{ height: bottomPad }} />
    </div>
  );
}
