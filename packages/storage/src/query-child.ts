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

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACTOR_VERSION } from "../../contracts/src/types.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Params = Record<string, unknown>;

class QErr extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const snapshotDir = process.argv[2];
if (!snapshotDir) {
  process.send?.({ type: "fatal", error: { code: "INVALID_INPUT", message: "snapshot directory missing" } });
  process.exit(2);
}

const manifestPath = path.join(snapshotDir, "manifest.json");
const dbPath = path.join(snapshotDir, "index.sqlite");
const sourcesDir = path.join(snapshotDir, "sources");

interface Manifest {
  schemaVersion: number;
  protocolVersion: number;
  extractorVersion: string;
  snapshotId: string;
  status: string;
  rootInstanceId: string;
  rootPath: string;
  topModule: string;
  sources: Array<{ sourceId: string; displayPath: string; sha256: string; bytes: number }>;
}

let manifest: Manifest;
let db: DatabaseSync;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1) {
    throw new QErr("UNSUPPORTED_VERSION", "snapshot schema/protocol version unsupported");
  }
  if (manifest.extractorVersion !== EXTRACTOR_VERSION) {
    throw new QErr("SNAPSHOT_VERSION_MISMATCH", "snapshot extractor version does not match this program");
  }
  if (manifest.status !== "COMPLETE") {
    throw new QErr("SNAPSHOT_INCOMPLETE", "snapshot is not published");
  }
  db = new DatabaseSync(dbPath, {
    readOnly: true,
    readBigInts: true,
    allowExtension: false,
    defensive: true,
    timeout: 1000,
  });
  db.exec("PRAGMA query_only = ON;");
} catch (err) {
  const code = err instanceof QErr ? err.code : "SNAPSHOT_CORRUPT";
  process.send?.({ type: "fatal", error: { code, message: err instanceof Error ? err.message : String(err) } });
  process.exit(2);
}

function str(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length === 0) throw new QErr("INVALID_INPUT", `${label} must be a string`);
  return v;
}
function optStr(v: unknown, label: string): string | null {
  if (v === undefined || v === null) return null;
  return str(v, label);
}
function num(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new QErr("INVALID_INPUT", `${label} must be an integer in [${min}, ${max}]`);
  }
  return v;
}
function optNum(v: unknown, label: string, min: number, max: number): number | null {
  if (v === undefined || v === null) return null;
  return num(v, label, min, max);
}
function pageSize(v: unknown): number {
  return Math.min(1000, Math.max(1, typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 200));
}
function idStr(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function numSafe(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isSafeInteger(n) ? n : null;
}
function mustId(v: unknown, label: string): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
  throw new QErr("INVALID_INPUT", `${label} must be a decimal id`);
}
function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function unb64url(s: string): string {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    throw new QErr("STALE_CURSOR", "invalid cursor");
  }
}
interface Cursor { v: 1; snapshot: string; kind: string; filter: string; key: Array<string | number> }
function encodeCursor(kind: string, filter: string, key: Array<string | number>): string {
  return b64url(JSON.stringify({ v: 1, snapshot: manifest.snapshotId, kind, filter, key } satisfies Cursor));
}
function decodeCursor(raw: unknown, kind: string, filter: string): Cursor {
  if (raw === undefined || raw === null || raw === "") return { v: 1, snapshot: manifest.snapshotId, kind, filter, key: [] };
  const c = JSON.parse(unb64url(str(raw, "cursor"))) as Cursor;
  if (c.v !== 1 || c.snapshot !== manifest.snapshotId || c.kind !== kind || c.filter !== filter) {
    throw new QErr("STALE_CURSOR", "cursor does not belong to this snapshot/filter");
  }
  if (!Array.isArray(c.key)) throw new QErr("STALE_CURSOR", "invalid cursor key");
  return c;
}
function toRecord(row: Record<string, unknown>): Json {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(row)) out[k] = toJson(v);
  return out;
}
function toJson(v: unknown): Json {
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v as Json;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = toJson(x);
    return o;
  }
  return null;
}
function listRows(sql: string, params: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  return stmt.all(...(params as never[])) as Record<string, unknown>[];
}
function oneRow(sql: string, params: unknown[]): Record<string, unknown> | undefined {
  const stmt = db.prepare(sql);
  return stmt.get(...(params as never[])) as Record<string, unknown> | undefined;
}
function countRows(sql: string, params: unknown[]): number {
  const r = oneRow(sql, params);
  return r ? Number(r.c ?? 0) : 0;
}
function sourcePathFor(sourceId: string): { row: Record<string, unknown>; file: string } {
  const row = oneRow("SELECT id, display_path, blob_sha, byte_length, line_count, encoding FROM source_file WHERE id = ?", [sourceId]);
  if (!row) throw new QErr("SOURCE_UNAVAILABLE", "source not found");
  if (!/^[0-9a-f]{64}$/.test(String(row.blob_sha))) throw new QErr("SNAPSHOT_CORRUPT", "bad source digest");
  return { row, file: path.join(sourcesDir, `${String(row.blob_sha)}.bin`) };
}
function lineForByte(sourceId: string, byteOffset: number): number {
  const r = oneRow(
    "SELECT line_no FROM source_line WHERE source_id = ? AND start_byte <= ? ORDER BY line_no DESC LIMIT 1",
    [sourceId, byteOffset],
  );
  return r ? Number(r.line_no) : 1;
}
function targetKind(occ: Record<string, unknown>): string | null {
  if (occ.target_symbol_id !== null && occ.target_symbol_id !== undefined) return "symbol";
  if (occ.target_macro_id !== null && occ.target_macro_id !== undefined) return "macro";
  if (occ.target_definition_id !== null && occ.target_definition_id !== undefined) return "definition";
  // An explicit source target wins over the instance context. Type parameter
  // references carry target_instance_id so navigation can switch to the
  // parent instance while still targeting the override expression.
  if (occ.target_source_id !== null && occ.target_source_id !== undefined) return "source";
  if (occ.target_instance_id !== null && occ.target_instance_id !== undefined) return "instance";
  return null;
}
function targetId(occ: Record<string, unknown>): string | null {
  for (const k of ["target_symbol_id", "target_instance_id", "target_macro_id", "target_definition_id", "target_source_id"]) {
    if (occ[k] !== null && occ[k] !== undefined) return idStr(occ[k]);
  }
  return null;
}
function occurrenceJson(occ: Record<string, unknown>) {
  return {
    occurrenceId: idStr(occ.id),
    startByte: numSafe(occ.start_byte),
    endByte: numSafe(occ.end_byte),
    kind: String(occ.kind),
    role: String(occ.role),
    status: String(occ.status) as "resolved" | "ambiguous" | "unresolved" | "unsupported" | "inactive",
    targetKind: targetKind(occ),
    targetId: targetId(occ),
    targetSymbolKind: typeof occ.target_symbol_kind === "string" ? occ.target_symbol_kind : null,
    targetInstanceId: occ.target_instance_id === null || occ.target_instance_id === undefined ? null : idStr(occ.target_instance_id),
    targetSourceId: occ.target_source_id === null || occ.target_source_id === undefined ? null : idStr(occ.target_source_id),
    targetStartByte: numSafe(occ.target_start_byte),
    targetEndByte: numSafe(occ.target_end_byte),
    targetLine: numSafe(occ.target_line),
    label: typeof occ.detail === "string" ? occ.detail : null,
  };
}
function instanceRow(id: string): Record<string, unknown> | undefined {
  return oneRow("SELECT id,parent_id,module_name,body_id,path,source_id,line,depth FROM instance WHERE id = ?", [id]);
}

// Maps scope id -> distance from the selected instance (0 = its own generate
// scope). Used to pick the occurrence matching the current generate iteration
// when the same source token is indexed once per iteration.
function scopeDepthsForInstance(instanceId: string): Map<string, number> {
  const rows = listRows(
    `WITH RECURSIVE anc(id, depth) AS (
       SELECT id, 0 FROM instance WHERE id = ?
       UNION ALL
       SELECT i.parent_id, anc.depth + 1 FROM instance i JOIN anc ON i.id = anc.id
        WHERE i.parent_id IS NOT NULL
     )
     SELECT i.scope_id AS scope_id, anc.depth AS depth
       FROM instance i JOIN anc ON anc.id = i.id
      WHERE i.scope_id IS NOT NULL`,
    [instanceId],
  );
  const out = new Map<string, number>();
  for (const row of rows) out.set(idStr(row.scope_id), Number(row.depth));
  return out;
}

function occurrenceDepth(row: Record<string, unknown>, scopeDepths: Map<string, number>): number {
  if (row.target_scope_id === null || row.target_scope_id === undefined) return Number.POSITIVE_INFINITY;
  return scopeDepths.get(idStr(row.target_scope_id)) ?? Number.POSITIVE_INFINITY;
}
function instanceKind(moduleName: unknown, definitionId: unknown): "instance" | "generate" | "generate_array" | "generate_iter" {
  if (definitionId !== null && definitionId !== undefined) return "instance";
  if (String(moduleName) === "$generate_array") return "generate_array";
  if (String(moduleName) === "$generate_iter") return "generate_iter";
  return "generate";
}
function lineTextFor(sourceId: unknown, line: unknown): string | null {
  if (sourceId === null || sourceId === undefined || line === null || line === undefined) return null;
  const lr = oneRow("SELECT start_byte,end_byte FROM source_line WHERE source_id=? AND line_no=?", [idStr(sourceId), Number(line)]);
  if (!lr) return null;
  const { file } = sourcePathFor(idStr(sourceId));
  if (!fs.existsSync(file)) return null;
  const full = fs.readFileSync(file);
  let text = full.subarray(Number(lr.start_byte), Number(lr.end_byte)).toString("utf8");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  return text.trim().replace(/[ \t]+/g, " ");
}

function hierarchyChildren(p: Params) {
  const parent = optStr(p.parentId, "parentId");
  const limit = pageSize(p.limit);
  const filter = `parent=${parent ?? "root"}`;
  const cursor = decodeCursor(p.cursor, "children", filter);
  const afterOrd = cursor.key.length >= 2 ? Number(cursor.key[0]) : -1;
  const afterId = cursor.key.length >= 2 ? String(cursor.key[1]) : "0";
  const where: string[] = [];
  const vals: unknown[] = [];
  if (parent === null) where.push("i.parent_id IS NULL");
  else {
    where.push("i.parent_id = ?");
    vals.push(parent);
  }
  if (cursor.key.length >= 2) {
    where.push("(i.ordinal > ? OR (i.ordinal = ? AND i.id > ?))");
    vals.push(afterOrd, afterOrd, afterId);
  }
  const sql = `SELECT i.id,i.parent_id,i.ordinal,i.name,i.module_name,i.path,i.source_id,i.line,i.depth,
      i.definition_id, d.source_id AS def_source_id, d.line AS def_line,
      EXISTS(SELECT 1 FROM instance c WHERE c.parent_id=i.id) AS has_children
    FROM instance i LEFT JOIN definition d ON d.id=i.definition_id WHERE ${where.join(" AND ")}
    ORDER BY i.ordinal, i.id LIMIT ?`;
  const rows = listRows(sql, [...vals, limit + 1]);
  const hasMore = rows.length > limit;
  const use = hasMore ? rows.slice(0, limit) : rows;
  const records = use.map((r) => ({
    id: idStr(r.id), parentId: r.parent_id === null ? null : idStr(r.parent_id),
    ordinal: Number(r.ordinal), name: String(r.name), moduleName: String(r.module_name),
    kind: instanceKind(r.module_name, r.definition_id),
    path: String(r.path), sourceId: r.source_id === null ? null : idStr(r.source_id),
    line: numSafe(r.line), definitionSourceId: r.def_source_id === null ? null : idStr(r.def_source_id),
    definitionLine: numSafe(r.def_line), hasChildren: Boolean(r.has_children), depth: Number(r.depth),
  }));
  const last = use[use.length - 1];
  return {
    records,
    nextCursor: hasMore && last ? encodeCursor("children", filter, [Number(last.ordinal), idStr(last.id)]) : null,
    complete: !hasMore,
    total: countRows(`SELECT COUNT(*) AS c FROM instance i WHERE ${parent === null ? "i.parent_id IS NULL" : "i.parent_id = ?"}`, parent === null ? [] : [parent]),
  };
}

function hierarchySearch(p: Params) {
  const query = str(p.query, "query").trim();
  if (!query) throw new QErr("INVALID_INPUT", "query must not be empty");
  if (query.length > 200) throw new QErr("INVALID_INPUT", "query is too long");
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;
  // Plain text searches instance/module names and the module definition file.
  // Matching the full hierarchy path would make every descendant of the root
  // match the root's name, so paths are only searched for explicit hierarchical
  // queries such as `top.u8` or `top/gen`.
  const clauses = [
    "i.name LIKE ? ESCAPE '\\'",
    "i.module_name LIKE ? ESCAPE '\\'",
    "ds.display_path LIKE ? ESCAPE '\\'",
  ];
  const vals: unknown[] = [pattern, pattern, pattern];
  if (query.includes(".") || query.includes("/")) {
    clauses.push("i.path LIKE ? ESCAPE '\\'");
    vals.push(pattern);
  }
  const where = `(${clauses.join(" OR ")})`;
  const from = `instance i LEFT JOIN definition d ON d.id=i.definition_id
      LEFT JOIN source_file ds ON ds.id=d.source_id`;
  const rows = listRows(
    `SELECT i.id,i.parent_id,i.ordinal,i.name,i.module_name,i.path,i.source_id,i.line,i.depth,
        i.definition_id, d.source_id AS def_source_id, d.line AS def_line,
        EXISTS(SELECT 1 FROM instance c WHERE c.parent_id=i.id) AS has_children
      FROM ${from}
      WHERE ${where} ORDER BY i.path, i.id LIMIT 2000`,
    vals,
  );
  const total = countRows(`SELECT COUNT(*) AS c FROM ${from} WHERE ${where}`, vals);
  return {
    records: rows.map((r) => ({
      id: idStr(r.id), parentId: r.parent_id === null ? null : idStr(r.parent_id),
      ordinal: Number(r.ordinal), name: String(r.name), moduleName: String(r.module_name),
      kind: instanceKind(r.module_name, r.definition_id),
      path: String(r.path), sourceId: r.source_id === null ? null : idStr(r.source_id),
      line: numSafe(r.line), definitionSourceId: r.def_source_id === null ? null : idStr(r.def_source_id),
      definitionLine: numSafe(r.def_line), hasChildren: Boolean(r.has_children), depth: Number(r.depth),
    })),
    total,
    complete: rows.length >= total,
  };
}

function hierarchyAncestors(p: Params) {
  const id = mustId(p.instanceId, "instanceId");
  const rows = listRows(
    `WITH RECURSIVE a(id,parent_id,ordinal,name,module_name,path,source_id,line,depth,definition_id) AS (
       SELECT id,parent_id,ordinal,name,module_name,path,source_id,line,depth,definition_id FROM instance WHERE id=?
       UNION ALL
       SELECT i.id,i.parent_id,i.ordinal,i.name,i.module_name,i.path,i.source_id,i.line,i.depth,i.definition_id
         FROM instance i JOIN a ON a.parent_id=i.id
     ) SELECT a.*, d.source_id AS def_source_id, d.line AS def_line
       FROM a LEFT JOIN definition d ON d.id=a.definition_id ORDER BY depth ASC`,
    [id],
  );
  return rows.map((r) => ({
    id: idStr(r.id), parentId: r.parent_id === null ? null : idStr(r.parent_id),
    ordinal: Number(r.ordinal), name: String(r.name), moduleName: String(r.module_name),
    kind: instanceKind(r.module_name, r.definition_id),
    path: String(r.path), sourceId: r.source_id === null ? null : idStr(r.source_id),
    line: numSafe(r.line), definitionSourceId: r.def_source_id === null ? null : idStr(r.def_source_id),
    definitionLine: numSafe(r.def_line), hasChildren: true, depth: Number(r.depth),
  }));
}

function sourceWindow(p: Params) {
  const sourceId = mustId(p.sourceId, "sourceId");
  const instanceId = optStr(p.instanceId, "instanceId");
  const maxBytes = Math.min(262144, Math.max(1024, Number(p.maxBytes ?? 262144)));
  const { row, file } = sourcePathFor(sourceId);
  if (!fs.existsSync(file)) throw new QErr("SOURCE_UNAVAILABLE", "source blob missing");
  const full = fs.readFileSync(file);
  const totalLines = Number(row.line_count);
  const offset = optNum(p.byteOffset, "byteOffset", 0, full.length);
  let startLine = optNum(p.startLine, "startLine", 1, Math.max(1, totalLines));
  if (startLine === null) startLine = optNum(p.line, "line", 1, Math.max(1, totalLines));
  if (startLine === null && offset !== null) startLine = lineForByte(sourceId, offset);
  if (startLine === null) startLine = 1;
  const contextLines = optNum(p.contextLines, "contextLines", 0, 1000) ?? 0;
  startLine = Math.max(1, startLine - contextLines);
  const scopeByte = optNum(p.scopeByte, "scopeByte", 0, full.length);
  let bodyId: string | null = null;
  if (instanceId) {
    const inst = instanceRow(instanceId);
    if (!inst) throw new QErr("SNAPSHOT_MISMATCH", "instance not found");
    bodyId = idStr(inst.body_id);
  }
  let activeRegions: Array<{ startByte: number; endByte: number; kind: string; label: string | null }> = [];
  let sourceScopes: Array<Record<string, unknown>> = [];
  let chosenScope: Record<string, unknown> | null = null;
  let currentDefinitionId: string | null = null;
  if (bodyId) {
    const bodyRow = oneRow("SELECT definition_id FROM body WHERE id=?", [bodyId]);
    currentDefinitionId = bodyRow?.definition_id === null || bodyRow?.definition_id === undefined
      ? null : idStr(bodyRow.definition_id);
  }
  if (bodyId || scopeByte !== null) {
    sourceScopes = listRows(
      `SELECT definition_id, start_byte, end_byte, kind, name FROM source_scope
        WHERE source_id = ? ORDER BY start_byte`,
      [sourceId],
    );
  }
  if (scopeByte !== null) {
    chosenScope = sourceScopes.find((r) =>
      Number(r.start_byte) <= scopeByte && Number(r.end_byte) > scopeByte) ?? null;
  } else if (currentDefinitionId) {
    chosenScope = sourceScopes.find((r) =>
      r.definition_id !== null && r.definition_id !== undefined &&
      idStr(r.definition_id) === currentDefinitionId) ?? null;
  }
  if (chosenScope) {
    const firstStart = Math.min(...sourceScopes.map((r) => Number(r.start_byte)));
    // File-level directives and comments before the first definition are
    // shared by every definition in the file; keep them interactive.
    if (firstStart > 0) {
      activeRegions.push({ startByte: 0, endByte: firstStart, kind: "file", label: null });
    }
    activeRegions.push({
      startByte: Number(chosenScope.start_byte), endByte: Number(chosenScope.end_byte),
      kind: String(chosenScope.kind), label: String(chosenScope.name),
    });
  }
  const inactiveRegions = bodyId
    ? (instanceId
        ? listRows(
            `WITH RECURSIVE anc(id) AS (
               SELECT id FROM instance WHERE id = ?
               UNION ALL
               SELECT i.parent_id FROM instance i JOIN anc ON i.id = anc.id
                WHERE i.parent_id IS NOT NULL
             )
             SELECT start_byte, end_byte, kind, label FROM inactive_region
              WHERE body_id = ? AND source_id = ?
                AND (owner_instance_id IS NULL OR owner_instance_id IN (SELECT id FROM anc))
              ORDER BY start_byte`,
            [instanceId, bodyId, sourceId],
          )
        : listRows(
            `SELECT start_byte, end_byte, kind, label FROM inactive_region
              WHERE body_id = ? AND source_id = ? ORDER BY start_byte`,
            [bodyId, sourceId],
          )
      ).map((r) => ({
        startByte: Number(r.start_byte), endByte: Number(r.end_byte),
        kind: String(r.kind), label: r.label === null ? null : String(r.label),
      }))
    : [];
  if (activeRegions.length > 0) {
    // Packages in the same file are not part of the module scope even when
    // they sit before the first module definition (and thus inside the
    // file-level prologue region).
    for (const r of sourceScopes) {
      if (r.definition_id !== null && r.definition_id !== undefined) continue;
      if (String(r.kind) !== "package") continue;
      if (chosenScope && Number(chosenScope.start_byte) === Number(r.start_byte) &&
          Number(chosenScope.end_byte) === Number(r.end_byte)) continue;
      inactiveRegions.push({
        startByte: Number(r.start_byte), endByte: Number(r.end_byte),
        kind: "package", label: String(r.name),
      });
    }
  }
  // Preprocessor-skipped branches are source-wide, independent of the current
  // instance or package scope.
  for (const r of listRows(
    `SELECT start_byte, end_byte, kind, label FROM preprocessor_region
      WHERE source_id = ? ORDER BY start_byte`,
    [sourceId],
  )) {
    inactiveRegions.push({
      startByte: Number(r.start_byte), endByte: Number(r.end_byte),
      kind: String(r.kind), label: r.label === null ? null : String(r.label),
    });
  }
  const byteActive = (start: number, end: number): boolean => {
    if (activeRegions.length && !activeRegions.some((r) => end > r.startByte && start < r.endByte)) {
      return false;
    }
    return !inactiveRegions.some((r) => end > r.startByte && start < r.endByte);
  };
  const lineRows = listRows(
    "SELECT line_no,start_byte,end_byte FROM source_line WHERE source_id=? AND line_no>=? ORDER BY line_no LIMIT 4000",
    [sourceId, startLine],
  );
  const lines: any[] = [];
  let bytes = 0;
  let endLine = startLine;
  let nextLine: number | null = null;
  for (const lr of lineRows) {
    const s = Number(lr.start_byte);
    const e = Number(lr.end_byte);
    if (lines.length > 0 && bytes + (e - s) > maxBytes) {
      nextLine = Number(lr.line_no);
      break;
    }
    let text = full.subarray(s, e).toString("utf8");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    const inScope = activeRegions.length === 0 ||
      activeRegions.some((r) => e > r.startByte && s < r.endByte);
    const whollyInactive = inactiveRegions.some((r) => r.startByte <= s && r.endByte >= e);
    lines.push({ line: Number(lr.line_no), text, startByte: s, endByte: e, active: inScope && !whollyInactive });
    bytes += e - s;
    endLine = Number(lr.line_no);
  }
  if (nextLine === null && endLine < totalLines) nextLine = endLine + 1;
  const complete = totalLines === 0 ? true : nextLine === null && endLine >= totalLines;
  const truncated = !complete;
  const startByte = lines.length ? lines[0].startByte : 0;
  const endByte = lines.length ? lines[lines.length - 1].endByte : 0;
  // Macro headers such as include/axi/typedef.svh are shared by many package
  // and module bodies. Their occurrences are indexed under those bodies, so
  // filtering by the currently selected instance would hide every typedef
  // reference in the file.
  const macroHeader = !!oneRow("SELECT 1 AS x FROM macro_definition WHERE source_id=? LIMIT 1", [sourceId]);
  const packageScope = !!chosenScope && String(chosenScope.kind) === "package";
  const filterByBody = !!bodyId && !macroHeader && !packageScope;
  const occSql = filterByBody
    ? "SELECT o.*, s.kind AS target_symbol_kind, s.scope_id AS target_scope_id FROM occurrence o LEFT JOIN symbol s ON s.id=o.target_symbol_id WHERE o.source_id=? AND o.end_byte>? AND o.start_byte<? AND (o.body_id=? OR o.body_id IS NULL) ORDER BY o.start_byte,o.id LIMIT 5000"
    : "SELECT o.*, s.kind AS target_symbol_kind, s.scope_id AS target_scope_id FROM occurrence o LEFT JOIN symbol s ON s.id=o.target_symbol_id WHERE o.source_id=? AND o.end_byte>? AND o.start_byte<? ORDER BY o.start_byte,o.id LIMIT 5000";
  const occParams = filterByBody ? [sourceId, startByte, endByte, bodyId] : [sourceId, startByte, endByte];
  const scopeDepths = instanceId ? scopeDepthsForInstance(instanceId) : new Map<string, number>();
  const refsBySpan = new Map<string, { ref: ReturnType<typeof occurrenceJson>; depth: number }>();
  for (const row of listRows(occSql, occParams)) {
    const ref = occurrenceJson(row);
    if (ref.startByte === null || ref.endByte === null || !byteActive(ref.startByte, ref.endByte)) continue;
    const key = `${ref.startByte}:${ref.endByte}:${ref.kind}:${ref.role}`;
    const depth = occurrenceDepth(row, scopeDepths);
    const prev = refsBySpan.get(key);
    if (!prev || depth < prev.depth) refsBySpan.set(key, { ref, depth });
  }
  const refs = [...refsBySpan.values()].map((entry) => entry.ref);
  return {
    snapshotId: manifest.snapshotId, sourceId, displayPath: String(row.display_path),
    language: null, startLine: lines.length ? lines[0].line : startLine, endLine, totalLines,
    lines, refs, activeRegions, inactiveRegions, truncated, complete, nextLine,
  };
}

function resolve(p: Params) {
  const sourceId = mustId(p.sourceId, "sourceId");
  const byteOffset = num(p.byteOffset, "byteOffset", 0, Number.MAX_SAFE_INTEGER);
  const instanceId = optStr(p.instanceId, "instanceId");
  let bodyId: string | null = null;
  if (instanceId) {
    const inst = instanceRow(instanceId);
    if (!inst) throw new QErr("SNAPSHOT_MISMATCH", "instance not found");
    bodyId = idStr(inst.body_id);
  }
  const macroHeader = !!oneRow("SELECT 1 AS x FROM macro_definition WHERE source_id=? LIMIT 1", [sourceId]);
  const inPackage = !!oneRow(
    "SELECT 1 AS x FROM source_scope WHERE source_id=? AND kind='package' AND start_byte<=? AND end_byte>? LIMIT 1",
    [sourceId, byteOffset, byteOffset],
  );
  const filterByBody = !!bodyId && !macroHeader && !inPackage;
  const occSql = filterByBody
    ? "SELECT o.*, s.kind AS target_symbol_kind, s.scope_id AS target_scope_id FROM occurrence o LEFT JOIN symbol s ON s.id=o.target_symbol_id WHERE o.source_id=? AND o.start_byte<=? AND o.end_byte>? AND (o.body_id=? OR o.body_id IS NULL) ORDER BY (o.end_byte-o.start_byte) ASC, o.id ASC LIMIT 500"
    : "SELECT o.*, s.kind AS target_symbol_kind, s.scope_id AS target_scope_id FROM occurrence o LEFT JOIN symbol s ON s.id=o.target_symbol_id WHERE o.source_id=? AND o.start_byte<=? AND o.end_byte>? ORDER BY (o.end_byte-o.start_byte) ASC, o.id ASC LIMIT 500";
  const rows = listRows(occSql, filterByBody
    ? [sourceId, byteOffset, byteOffset, bodyId]
    : [sourceId, byteOffset, byteOffset]);
  let occ: Record<string, unknown> | undefined;
  if (rows.length) {
    const minLength = Math.min(...rows.map((row) => Number(row.end_byte) - Number(row.start_byte)));
    const candidates = rows.filter((row) => Number(row.end_byte) - Number(row.start_byte) === minLength);
    const scopeDepths = instanceId ? scopeDepthsForInstance(instanceId) : new Map<string, number>();
    let bestDepth = Number.POSITIVE_INFINITY;
    for (const row of candidates) {
      const depth = occurrenceDepth(row, scopeDepths);
      if (!occ || depth < bestDepth) {
        occ = row;
        bestDepth = depth;
      }
    }
  }
  if (!occ) {
    return { status: "unresolved", occurrenceId: null, kind: null, role: null, targetKind: null, targetId: null, targetInstanceId: null, targetSourceId: null, targetLine: null, label: null, message: "no resolved object at this position" };
  }
  return {
    ...occurrenceJson(occ),
    message: occ.status === "resolved" ? null : String(occ.status),
  };
}

function hover(p: Params) {
  let occ: Record<string, unknown> | undefined;
  if (p.occurrenceId) {
    occ = oneRow("SELECT * FROM occurrence WHERE id=?", [mustId(p.occurrenceId, "occurrenceId")]);
  } else {
    const r = resolve(p);
    if (!r.occurrenceId) {
      return { status: "unresolved", title: "", declaration: null, sourceLine: null, kind: null, typeText: null, width: null, signed: null, packedDims: null, unpackedDims: null, direction: null, defaultValue: null, actualValue: null, macroBody: null, targetInstanceId: null, targetSourceId: null, targetLine: null, message: r.message };
    }
    occ = oneRow("SELECT * FROM occurrence WHERE id=?", [r.occurrenceId]);
  }
  if (!occ) throw new QErr("SNAPSHOT_MISMATCH", "occurrence not found");
  const base = {
    status: String(occ.status) as any, title: "", declaration: null as string | null, sourceLine: null as string | null,
    kind: null as string | null,
    typeText: null as string | null, width: null as number | null, signed: null as boolean | null,
    packedDims: null as string | null, unpackedDims: null as string | null,
    direction: null as string | null, defaultValue: null as string | null, actualValue: null as string | null,
    macroBody: null as string | null,
    targetInstanceId: occ.target_instance_id === null || occ.target_instance_id === undefined ? null : idStr(occ.target_instance_id),
    targetSourceId: occ.target_source_id === null ? null : idStr(occ.target_source_id),
    targetLine: numSafe(occ.target_line), message: null as string | null,
  };
  if (occ.kind === "member") {
    const detail = typeof occ.detail === "string" ? occ.detail : "";
    const eq = detail.indexOf(" = ");
    const name = eq >= 0 ? detail.slice(0, eq) : "member";
    const value = eq >= 0 ? detail.slice(eq + 3) : "";
    base.title = name === "member" ? "member" : `member ${name}`;
    base.kind = "member";
    base.actualValue = value || null;
    base.sourceLine = lineTextFor(occ.target_source_id, occ.target_line);
    base.declaration = base.sourceLine;
    return base;
  }
  if (occ.target_symbol_id !== null && occ.target_symbol_id !== undefined) {
    const s = oneRow("SELECT name,kind,declared_type,actual_type,width,is_signed,packed_dims,unpacked_dims,direction,default_value,actual_value,source_id,line FROM symbol WHERE id=?", [idStr(occ.target_symbol_id)]);
    if (s) {
      const typeText = (s.actual_type ?? s.declared_type ?? null) as string | null;
      base.title = String(s.kind);
      base.sourceLine = lineTextFor(s.source_id, s.line) ?? lineTextFor(occ.target_source_id, occ.target_line);
      base.declaration = base.sourceLine;
      base.kind = String(s.kind);
      base.typeText = typeText;
      base.width = numSafe(s.width);
      base.signed = s.is_signed === null ? null : Boolean(s.is_signed);
      base.packedDims = s.packed_dims === null ? null : String(s.packed_dims);
      base.unpackedDims = s.unpacked_dims === null ? null : String(s.unpacked_dims);
      base.direction = s.direction === null ? null : String(s.direction);
      base.defaultValue = s.default_value === null ? null : String(s.default_value);
      base.actualValue = s.actual_value === null ? null : String(s.actual_value);
      return base;
    }
  }
  if (occ.target_macro_id !== null && occ.target_macro_id !== undefined) {
    const m = oneRow("SELECT name,body,source_id,line FROM macro_definition WHERE id=?", [idStr(occ.target_macro_id)]);
    if (m) {
      base.title = "macro";
      base.sourceLine = lineTextFor(m.source_id, m.line);
      base.declaration = base.sourceLine;
      base.kind = "macro";
      base.macroBody = m.body === null ? null : String(m.body);
      base.targetLine = numSafe(m.line);
      return base;
    }
  }
  if (occ.target_definition_id !== null && occ.target_definition_id !== undefined) {
    const d = oneRow("SELECT kind,name,qualified_name,source_id,line FROM definition WHERE id=?", [idStr(occ.target_definition_id)]);
    if (d) {
      base.title = String(d.kind);
      base.sourceLine = lineTextFor(d.source_id, d.line) ?? lineTextFor(occ.target_source_id, occ.target_line);
      base.declaration = base.sourceLine;
      base.kind = String(d.kind);
      base.targetLine = numSafe(d.line);
      return base;
    }
  }
  if (occ.target_source_id !== null && occ.target_source_id !== undefined) {
    const sf = oneRow("SELECT display_path FROM source_file WHERE id=?", [idStr(occ.target_source_id)]);
    if (sf) {
      if (occ.kind === "type") {
        base.title = "type";
        base.sourceLine = lineTextFor(occ.target_source_id, occ.target_line);
        base.declaration = base.sourceLine;
        base.kind = "type";
      } else if (occ.kind === "package") {
        base.title = "package";
        base.sourceLine = lineTextFor(occ.target_source_id, occ.target_line);
        base.declaration = base.sourceLine;
        base.kind = "package";
      } else {
        base.title = occ.kind === "include" ? "include" : "source";
        base.sourceLine = lineTextFor(occ.target_source_id, occ.target_line);
        base.declaration = base.sourceLine;
        base.kind = String(occ.kind);
      }
      return base;
    }
  }
  if (occ.target_instance_id !== null && occ.target_instance_id !== undefined) {
    const inst = oneRow("SELECT path,module_name,source_id,line FROM instance WHERE id=?", [idStr(occ.target_instance_id)]);
    if (inst) {
      base.title = "instance";
      base.sourceLine = lineTextFor(inst.source_id, inst.line);
      base.declaration = String(inst.path);
      base.kind = "instance";
      base.targetSourceId = inst.source_id === null ? null : idStr(inst.source_id);
      base.targetLine = numSafe(inst.line);
      return base;
    }
  }
  base.status = "unsupported";
  base.message = "target kind is not supported by this query";
  return base;
}

let aliasTableAvailable: boolean | null = null;
function hasAliasTable(): boolean {
  if (aliasTableAvailable === null) {
    aliasTableAvailable = !!oneRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='symbol_alias'", []);
  }
  return aliasTableAvailable;
}
function aliasSymbolIds(symbolId: string, bodyId: string): string[] {
  const ids = new Set<string>([symbolId]);
  if (hasAliasTable()) {
    const rows = listRows(
      "SELECT symbol_id,alias_symbol_id FROM symbol_alias WHERE symbol_id=? OR alias_symbol_id=?",
      [symbolId, symbolId],
    );
    for (const row of rows) {
      ids.add(idStr(row.symbol_id));
      ids.add(idStr(row.alias_symbol_id));
    }
    if (rows.length > 0) return [...ids];
  }
  // Compatibility fallback for snapshots built before symbol_alias existed.
  const sym = oneRow("SELECT name,body_id,source_id,start_byte,end_byte FROM symbol WHERE id=?", [symbolId]);
  if (!sym) return [...ids];
  let rows = listRows(
    `SELECT id FROM symbol
      WHERE body_id=? AND name=? AND kind IN ('port','net','variable','field')
        AND source_id=? AND start_byte=? AND end_byte=?`,
    [bodyId, sym.name, sym.source_id, sym.start_byte, sym.end_byte],
  );
  if (rows.length === 0) {
    rows = listRows(
      "SELECT id FROM symbol WHERE body_id=? AND name=? AND kind IN ('port','net','variable','field')",
      [bodyId, sym.name],
    );
  }
  for (const row of rows) ids.add(idStr(row.id));
  return [...ids];
}

function driversList(p: Params) {
  const instanceId = mustId(p.instanceId, "instanceId");
  const symbolId = mustId(p.symbolId, "symbolId");
  const inst = instanceRow(instanceId);
  if (!inst) throw new QErr("SNAPSHOT_MISMATCH", "instance not found");
  const sym = oneRow("SELECT id,name FROM symbol WHERE id=?", [symbolId]);
  if (!sym) throw new QErr("SNAPSHOT_MISMATCH", "symbol not found");
  const filter = `inst=${instanceId};sym=${symbolId}`;
  const cursor = decodeCursor(p.cursor, "drivers", filter);
  const limit = pageSize(p.limit);
  const after = cursor.key.length ? mustId(cursor.key[0], "cursor id") : "0";
  const aliases = aliasSymbolIds(symbolId, idStr(inst.body_id));
  const aliasMarks = aliases.map(() => "?").join(",");
  const rows = listRows(
    `SELECT d.*, s.name AS target_name
       FROM driver d LEFT JOIN symbol s ON s.id=d.target_symbol_id
      WHERE d.target_symbol_id IN (${aliasMarks}) AND (d.body_id=? OR d.instance_id=?)
        AND d.id > ? ORDER BY d.id LIMIT ?`,
    [...aliases, idStr(inst.body_id), instanceId, after, limit + 1],
  );
  const total = countRows(
    `SELECT COUNT(*) AS c FROM driver WHERE target_symbol_id IN (${aliasMarks}) AND (body_id=? OR instance_id=?)`,
    [...aliases, idStr(inst.body_id), instanceId],
  );
  const hasMore = rows.length > limit;
  const use = hasMore ? rows.slice(0, limit) : rows;
  return {
    traceId: `drv:${manifest.snapshotId}:${instanceId}:${symbolId}`,
    snapshotId: manifest.snapshotId, direction: "driver" as const,
    originInstanceId: instanceId, originSymbolId: symbolId, bitSelection: p.bitSelection ?? null,
    records: use.map((r) => ({
      id: idStr(r.id), kind: String(r.kind), sourceKind: r.detail === null ? null : String(r.detail),
      targetInstanceId: r.instance_id === null ? instanceId : idStr(r.instance_id),
      targetSymbolId: idStr(r.target_symbol_id), targetBitLo: numSafe(r.target_bit_lo), targetBitHi: numSafe(r.target_bit_hi),
      sourceInstanceId: r.source_instance_id === null ? instanceId : idStr(r.source_instance_id),
      sourceSymbolId: r.source_symbol_id === null ? null : idStr(r.source_symbol_id),
      sourceBitLo: numSafe(r.source_bit_lo), sourceBitHi: numSafe(r.source_bit_hi),
      sourceId: r.source_id === null ? null : idStr(r.source_id), startByte: numSafe(r.start_byte),
      endByte: numSafe(r.end_byte), line: numSafe(r.line),
      exactness: String(r.exactness) as any, detail: r.detail === null ? null : String(r.detail),
      targetLabel: r.target_name === null ? null : String(r.target_name),
    })),
    nextCursor: hasMore ? encodeCursor("drivers", filter, [idStr(use[use.length - 1].id)]) : null,
    complete: !hasMore, total,
    status: total === 0 ? "no-driver" as const : "resolved" as const,
    message: total === 0 ? "analysis completed with no driver for this signal" : null,
  };
}

function loadsList(p: Params) {
  const instanceId = mustId(p.instanceId, "instanceId");
  const symbolId = mustId(p.symbolId, "symbolId");
  const inst = instanceRow(instanceId);
  if (!inst) throw new QErr("SNAPSHOT_MISMATCH", "instance not found");
  const sym = oneRow("SELECT id,name FROM symbol WHERE id=?", [symbolId]);
  if (!sym) throw new QErr("SNAPSHOT_MISMATCH", "symbol not found");
  const roles = Array.isArray(p.roles) ? p.roles.filter((x): x is string => typeof x === "string") : [];
  const roleClause = roles.length ? ` AND role IN (${roles.map(() => "?").join(",")})` : "";
  const filter = `inst=${instanceId};sym=${symbolId};roles=${roles.join(",")}`;
  const cursor = decodeCursor(p.cursor, "loads", filter);
  const limit = pageSize(p.limit);
  const after = cursor.key.length ? mustId(cursor.key[0], "cursor id") : "0";
  const aliases = aliasSymbolIds(symbolId, idStr(inst.body_id));
  const aliasMarks = aliases.map(() => "?").join(",");
  const base = `source_symbol_id IN (${aliasMarks}) AND (source_body_id=? OR source_instance_id=?)` + roleClause;
  const rows = listRows(
    `SELECT le.*, ts.name AS target_name, ss.name AS source_name
       FROM load_edge le
       LEFT JOIN symbol ts ON ts.id=le.target_symbol_id
       LEFT JOIN symbol ss ON ss.id=le.source_symbol_id
      WHERE ${base} AND le.id > ? ORDER BY le.id LIMIT ?`,
    [...aliases, idStr(inst.body_id), instanceId, ...roles, after, limit + 1],
  );
  const total = countRows(`SELECT COUNT(*) AS c FROM load_edge WHERE ${base}`, [...aliases, idStr(inst.body_id), instanceId, ...roles]);
  const hasMore = rows.length > limit;
  const use = hasMore ? rows.slice(0, limit) : rows;
  return {
    traceId: `load:${manifest.snapshotId}:${instanceId}:${symbolId}`,
    snapshotId: manifest.snapshotId, direction: "load" as const,
    originInstanceId: instanceId, originSymbolId: symbolId, bitSelection: p.bitSelection ?? null,
    records: use.map((r) => ({
      id: idStr(r.id), role: String(r.role) as any, exactness: String(r.exactness) as any,
      sourceInstanceId: r.source_instance_id === null ? instanceId : idStr(r.source_instance_id),
      sourceSymbolId: idStr(r.source_symbol_id), sourceBitLo: numSafe(r.source_bit_lo), sourceBitHi: numSafe(r.source_bit_hi),
      targetInstanceId: r.target_instance_id === null ? instanceId : idStr(r.target_instance_id),
      targetSymbolId: idStr(r.target_symbol_id), targetBitLo: numSafe(r.target_bit_lo), targetBitHi: numSafe(r.target_bit_hi),
      useSourceId: r.use_source_id === null ? null : idStr(r.use_source_id),
      useStartByte: numSafe(r.use_start_byte), useEndByte: numSafe(r.use_end_byte),
      targetSourceId: r.target_source_id === null ? null : idStr(r.target_source_id),
      targetStartByte: numSafe(r.target_start_byte), targetEndByte: numSafe(r.target_end_byte),
      targetLabel: r.target_name === null ? null : String(r.target_name), detail: r.detail === null ? null : String(r.detail),
    })),
    nextCursor: hasMore ? encodeCursor("loads", filter, [idStr(use[use.length - 1].id)]) : null,
    complete: !hasMore, total,
    status: total === 0 ? "no-load" as const : "resolved" as const,
    message: total === 0 ? "analysis completed with no direct load for this signal" : null,
  };
}

function symbolDefinition(p: Params) {
  const symbolId = mustId(p.symbolId, "symbolId");
  const row = oneRow("SELECT name,kind,source_id,start_byte,end_byte,line FROM symbol WHERE id=?", [symbolId]);
  if (!row) throw new QErr("SNAPSHOT_MISMATCH", "symbol not found");
  if (row.source_id === null || row.source_id === undefined) {
    return { status: "unsupported", sourceId: null, startByte: null, endByte: null, line: null, label: String(row.name), kind: String(row.kind), message: "symbol has no source location" };
  }
  return {
    status: "resolved",
    sourceId: idStr(row.source_id),
    startByte: numSafe(row.start_byte),
    endByte: numSafe(row.end_byte),
    line: numSafe(row.line),
    label: String(row.name),
    kind: String(row.kind),
    message: null,
  };
}

function inspectorPage(p: Params) {
  const instanceId = mustId(p.instanceId, "instanceId");
  const tab = str(p.tab, "tab");
  const inst = instanceRow(instanceId);
  if (!inst) throw new QErr("SNAPSHOT_MISMATCH", "instance not found");
  if (tab === "children") return { ...hierarchyChildren({ parentId: instanceId, cursor: p.cursor, limit: p.limit }), tab };
  const filter = `inst=${instanceId};tab=${tab}`;
  const cursor = decodeCursor(p.cursor, "inspector", filter);
  const limit = pageSize(p.limit);
  const afterByte = cursor.key.length ? Number(cursor.key[0]) : -1;
  const afterId = cursor.key.length ? String(cursor.key[1]) : "0";
  if (tab === "ports") {
    const rows = listRows(
      `SELECT id,name,direction,COALESCE(actual_type,declared_type) AS type_text,width,line,start_byte
         FROM symbol WHERE body_id=? AND kind='port'
          AND (COALESCE(start_byte,0)>? OR (COALESCE(start_byte,0)=? AND id>?))
        ORDER BY COALESCE(start_byte,0),id LIMIT ?`,
      [idStr(inst.body_id), afterByte, afterByte, afterId, limit + 1],
    );
    const total = countRows("SELECT COUNT(*) AS c FROM symbol WHERE body_id=? AND kind='port'", [idStr(inst.body_id)]);
    const hasMore = rows.length > limit;
    const use = hasMore ? rows.slice(0, limit) : rows;
    return {
      tab, records: use.map((r) => ({ symbolId: idStr(r.id), name: String(r.name), direction: String(r.direction ?? ""), typeText: String(r.type_text ?? ""), width: numSafe(r.width), line: numSafe(r.line) })),
      nextCursor: hasMore ? encodeCursor("inspector", filter, [Number(use[use.length - 1].start_byte ?? 0), idStr(use[use.length - 1].id)]) : null,
      complete: !hasMore, total,
    };
  }
  if (tab === "params") {
    const rows = listRows(
      `SELECT id,name,kind,COALESCE(actual_type,declared_type) AS type_text,default_value,actual_value,width,line,start_byte
         FROM symbol WHERE body_id=? AND kind IN ('parameter','localparam','type_parameter')
          AND (COALESCE(start_byte,0)>? OR (COALESCE(start_byte,0)=? AND id>?))
        ORDER BY COALESCE(start_byte,0),id LIMIT ?`,
      [idStr(inst.body_id), afterByte, afterByte, afterId, limit + 1],
    );
    const total = countRows("SELECT COUNT(*) AS c FROM symbol WHERE body_id=? AND kind IN ('parameter','localparam','type_parameter')", [idStr(inst.body_id)]);
    const hasMore = rows.length > limit;
    const use = hasMore ? rows.slice(0, limit) : rows;
    return {
      tab, records: use.map((r) => ({ symbolId: idStr(r.id), name: String(r.name), kind: String(r.kind), typeText: String(r.type_text ?? ""), defaultValue: r.default_value === null ? null : String(r.default_value), actualValue: r.actual_value === null ? null : String(r.actual_value), width: numSafe(r.width), line: numSafe(r.line) })),
      nextCursor: hasMore ? encodeCursor("inspector", filter, [Number(use[use.length - 1].start_byte ?? 0), idStr(use[use.length - 1].id)]) : null,
      complete: !hasMore, total,
    };
  }
  throw new QErr("INVALID_INPUT", "unknown inspector tab");
}

const methods: Record<string, (p: Params) => unknown> = {
  "snapshot.info": () => ({ snapshotId: manifest.snapshotId, rootInstanceId: manifest.rootInstanceId, rootPath: manifest.rootPath, topModule: manifest.topModule, sources: manifest.sources }),
  "hierarchy.children": hierarchyChildren,
  "hierarchy.ancestors": hierarchyAncestors,
  "hierarchy.search": hierarchySearch,
  "source.window": sourceWindow,
  "resolve": resolve,
  "hover": hover,
  "drivers.list": driversList,
  "loads.list": loadsList,
  "inspector.page": inspectorPage,
  "symbol.definition": symbolDefinition,
};

process.on("message", (msg: { id?: string; method?: string; params?: Params }) => {
  const id = msg?.id;
  if (!id) return;
  try {
    const method = msg.method ? methods[msg.method] : undefined;
    if (!method) throw new QErr("INVALID_INPUT", `unknown query method: ${String(msg.method)}`);
    const result = method(msg.params ?? {});
    process.send?.({ id, ok: true, data: toJson(result) });
  } catch (err) {
    const code = err instanceof QErr ? err.code : "INTERNAL_ERROR";
    process.send?.({ id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
  }
});
process.on("disconnect", () => process.exit(0));
