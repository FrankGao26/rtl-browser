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

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { workerExecutable } from "./lib/platform.mjs";

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT) : path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "dist", "server", "apps", "server", "src", "main.js");
const WORKER = workerExecutable(ROOT);
const FIXTURE = path.join(ROOT, "tests", "fixtures", "public", "common-cells");
const STATE = path.join(ROOT, "state", `advanced-${Date.now()}-${process.pid}`);
const PROJECT = path.join(STATE, "common-cells");
const NETWORK_MODE = process.env.RTL_NETWORK === "offline" ? "offline" : "online";
const EVIDENCE = path.join(ROOT, ".sandbox", "evidence", `advanced-smoke-${NETWORK_MODE}.json`);
const EVIDENCE_LATEST = path.join(ROOT, ".sandbox", "evidence", "advanced-smoke.json");
const HOST = "127.0.0.1";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hashTree(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === ".rtlb") continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(path.relative(dir, p)).update("\0").update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
function currentSessionDir(projectRoot) {
  const sessions = path.join(projectRoot, ".rtlb", "sessions");
  for (const name of fs.readdirSync(sessions)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessions, name, "session.json"), "utf8"));
      if (meta.pid === server.pid) return path.join(sessions, name);
    } catch { /* skip malformed */ }
  }
  throw new Error(`session directory not found under ${sessions}`);
}
function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) total += dirSize(p);
    else if (name.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

fs.mkdirSync(STATE, { recursive: true });
fs.cpSync(FIXTURE, PROJECT, { recursive: true, filter: (src) => path.basename(src) !== ".rtlb" });
const sourceBefore = hashTree(PROJECT);
const server = spawn(process.execPath, [
  MAIN, "--workspace", STATE, "--worker", WORKER,
  "--web", path.join(ROOT, "dist", "web"), "--port", "0",
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RTL_PROJECT_ROOT: ROOT },
});
let stderr = "";
server.stderr.on("data", (c) => { stderr = (stderr + c.toString()).slice(-20000); });
const urlLine = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error(`server did not start\n${stderr}`)), 15000);
  server.stdout.on("data", (c) => {
    buf += c.toString();
    const line = buf.split("\n").find((x) => x.startsWith("open: "));
    if (line) { clearTimeout(timer); resolve(line.slice(6).trim()); }
  });
  server.on("exit", (code) => { if (code !== null) reject(new Error(`server exited ${code}\n${stderr}`)); });
});
const parsed = new URL(urlLine);
const base = `http://${HOST}:${parsed.port}`;
const boot = await fetch(urlLine, { redirect: "manual" });
const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
const origin = base;
async function api(method, p, body, csrf) {
  const headers = { cookie, origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-rtl-csrf"] = csrf;
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 500)}`); }
  if (!j.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 1000)}`);
  return j.data;
}

try {
  const session = await api("GET", "/api/session");
  const csrf = session.csrfToken;
  await api("POST", "/api/workspace/open", { path: PROJECT }, csrf);
  const config = {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "cc_addr_decode",
    defines: [], includeRoots: [], libraries: [], parameters: [], language: "1800-2017",
    singleUnit: false, threads: 4, warningAsError: false, warningOptions: [],
  };
  const project = (await api("POST", "/api/projects", { config }, csrf)).project;
  const started = performance.now();
  const job = await api("POST", `/api/projects/${project.projectId}/build`, { configRevision: 1, requestKey: `advanced-${Date.now()}` }, csrf);
  let final = null;
  for (let i = 0; i < 600; i++) {
    final = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}`);
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(final.state)) break;
    await sleep(100);
  }
  const buildSeconds = (performance.now() - started) / 1000;
  if (final?.state !== "COMPLETE") {
    const diag = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}/diagnostics`);
    console.error("common_cells diagnostics:", JSON.stringify(diag.records.slice(0, 20), null, 2));
  }
  assert.equal(final?.state, "COMPLETE", `common_cells build did not complete: ${JSON.stringify(final)}\n${stderr}`);
  assert.equal(final.diagnostics.error, 0);
  const snaps = await api("GET", `/api/projects/${project.projectId}/snapshots`);
  const sid = snaps[0].snapshotId;
  const roots = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children`);
  assert.equal(roots.records[0].path, "cc_addr_decode");
  const root = roots.records[0];
  const source = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${root.definitionSourceId}&instanceId=${root.id}&startLine=1`);
  assert.equal(source.complete, true);
  assert.ok(source.lines.some((l) => l.text.includes("parameter type")));
  assert.ok(source.lines.some((l) => l.text.includes("struct packed")));
  assert.ok(source.refs.some((r) => r.label === "rule_t" && r.kind === "type" && r.status === "resolved" && r.targetLine === 68), "struct type reference resolves");
  const childPage = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children?parentId=${root.id}`);
  assert.equal(childPage.records.length, 1);
  const child = childPage.records[0];
  assert.equal(child.path, "cc_addr_decode.i_addr_decode_dync");
  assert.equal(child.moduleName, "cc_addr_decode_dync");
  const childSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${child.definitionSourceId}&instanceId=${child.id}&startLine=1`);
  const refText = (r) => {
    const line = childSource.lines.find((l) => l.startByte <= r.startByte && l.endByte > r.startByte);
    return line ? line.text.slice(r.startByte - line.startByte, r.endByte - line.startByte) : "";
  };
  // The child's idx_t/addr_t are overridden by the parent module, so type
  // references in the default struct follow the parent binding expression.
  const structFieldRefs = childSource.refs.filter((r) => r.kind === "type" &&
    r.targetSourceId === root.definitionSourceId && (r.targetLine === 99 || r.targetLine === 102));
  const fieldTexts = structFieldRefs.map(refText);
  assert.ok(fieldTexts.includes("idx_t"), "struct default field type idx_t follows the parent override");
  assert.ok(fieldTexts.filter((t) => t === "addr_t").length >= 2,
    "both struct default addr_t fields follow the parent override");
  const idxDeclLine = childSource.lines.find((l) => l.line === 53);
  assert.ok(idxDeclLine && idxDeclLine.text.includes("idx_t"));
  const idxDeclAt = idxDeclLine.startByte + Buffer.byteLength(
    idxDeclLine.text.slice(0, idxDeclLine.text.indexOf("idx_t")), "utf8");
  const idxDeclResolved = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${childSource.sourceId}&instanceId=${child.id}&byteOffset=${idxDeclAt}`);
  assert.equal(idxDeclResolved.targetSourceId, root.definitionSourceId);
  assert.equal(idxDeclResolved.targetLine, 102,
    "the child type parameter declaration jumps to the parent override");
  const idxTypeLine = childSource.lines.find((l) => l.line === 53);
  assert.ok(idxTypeLine);
  const idxWidthUse = childSource.refs.find((r) =>
    r.startByte === idxTypeLine.startByte + idxTypeLine.text.indexOf("IdxWidth"));
  assert.ok(idxWidthUse, "dimension in a type-parameter default is an occurrence");
  assert.equal(idxWidthUse.targetSymbolKind, "parameter");
  assert.equal(idxWidthUse.targetLine, 52);
  const noRulesLine = childSource.lines.find((l) => l.line === 82);
  assert.ok(noRulesLine);
  const noRulesUseOffset = noRulesLine.startByte + noRulesLine.text.indexOf("NoRules");
  const noRulesUse = childSource.refs.find((r) => r.startByte === noRulesUseOffset);
  assert.ok(noRulesUse, "NoRules inside a dimension is an occurrence");
  assert.equal(noRulesUse.kind, "symbol");
  assert.equal(noRulesUse.targetSymbolKind, "parameter");
  assert.equal(noRulesUse.targetLine, 98, "param reference follows the instance override");
  const noRulesUseHover = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${noRulesUse.occurrenceId}&instanceId=${child.id}`);
  assert.equal(noRulesUseHover.kind, "parameter");
  assert.match(noRulesUseHover.sourceLine, /parameter int unsigned NoRules/);
  const noRules = childSource.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith("NoRules"));
  assert.ok(noRules, "child parameter declaration is indexed");
  assert.equal(noRules.targetSourceId, root.definitionSourceId, "override target is in the parent file");
  assert.equal(noRules.targetInstanceId, root.id, "override target carries the parent instance");
  assert.equal(noRules.targetLine, 98, "override target points at the parent parameter list");
  const noRulesHover = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${noRules.occurrenceId}&instanceId=${child.id}`);
  assert.equal(noRulesHover.kind, "parameter");
  assert.equal(noRulesHover.actualValue, "32'd1");
  assert.equal(noRulesHover.typeText, "int unsigned");
  const noRulesDef = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/definition?symbolId=${noRules.targetId}`);
  assert.equal(noRulesDef.status, "resolved");
  assert.equal(noRulesDef.sourceId, child.definitionSourceId, "definition returns the child declaration, not the override");
  assert.equal(noRulesDef.line, 44);
  const macroRef = childSource.refs.find((r) => r.kind === "macro");
  assert.ok(macroRef, "assertion macros are indexed");
  const sessionSnapshotDir = path.join(currentSessionDir(PROJECT), "snapshots", sid);
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionSnapshotDir, "manifest.json"), "utf8"));
  assert.ok(manifest.sources.some((s) => s.displayPath.endsWith("cc_stream_intf.sv")), "interface source is captured");
  assert.ok(manifest.sources.some((s) => s.sourceId === macroRef.targetSourceId && s.displayPath.endsWith("assertions.svh")), "macro definition include is captured");
  const metrics = {
    design: "pulp-platform/common_cells cc_addr_decode",
    upstreamCommit: "e73baaec2ca665cd80c3c384e9258e35242b829c",
    buildSeconds: Number(buildSeconds.toFixed(3)),
    snapshotBytes: dirSize(sessionSnapshotDir),
    instances: final.counts.instances,
    symbols: final.counts.symbols,
    occurrences: final.counts.occurrences,
    counts: final.counts,
    diagnostics: final.diagnostics,
    note: "advanced SystemVerilog smoke test; interface/modport semantic edges are not complete",
  };
  assert.equal(hashTree(PROJECT), sourceBefore, "advanced fixture source changed");
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(metrics, null, 2) + "\n");
  fs.writeFileSync(EVIDENCE_LATEST, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`advanced-smoke: PASS ${JSON.stringify(metrics)}`);
} finally {
  server.kill("SIGTERM");
  await sleep(500);
  fs.rmSync(STATE, { recursive: true, force: true });
}
