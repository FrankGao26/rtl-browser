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
const EXAMPLE = path.join(ROOT, "examples", "pulp-axi");
const STATE = path.join(ROOT, "state", `pulp-axi-${Date.now()}-${process.pid}`);
const PROJECT = path.join(STATE, "pulp-axi");
const NETWORK_MODE = process.env.RTL_NETWORK === "offline" ? "offline" : "online";
const EVIDENCE = path.join(ROOT, ".sandbox", "evidence", `pulp-axi-smoke-${NETWORK_MODE}.json`);
const EVIDENCE_LATEST = path.join(ROOT, ".sandbox", "evidence", "pulp-axi-smoke.json");
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
fs.cpSync(EXAMPLE, PROJECT, { recursive: true, filter: (src) => path.basename(src) !== ".rtlb" });
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
async function api(method, p, body, csrf) {
  const headers = { cookie, origin: base };
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
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "pulp_axi_xbar_top",
    defines: [], includeRoots: [], libraries: [], parameters: [], language: "1800-2017",
    singleUnit: false, threads: 4, warningAsError: false, warningOptions: [],
  };
  const project = (await api("POST", "/api/projects", { config }, csrf)).project;
  const started = performance.now();
  const job = await api("POST", `/api/projects/${project.projectId}/build`, { configRevision: 1, requestKey: `pulp-axi-${Date.now()}` }, csrf);
  let final = null;
  for (let i = 0; i < 1200; i++) {
    final = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}`);
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(final.state)) break;
    await sleep(100);
  }
  const buildSeconds = (performance.now() - started) / 1000;
  if (final?.state !== "COMPLETE") {
    const diag = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}/diagnostics`);
    console.error("pulp-axi diagnostics:", JSON.stringify(diag.records.slice(0, 20), null, 2));
  }
  assert.equal(final?.state, "COMPLETE", `pulp-axi build did not complete: ${JSON.stringify(final)}\n${stderr}`);
  assert.equal(final.diagnostics.error, 0);
  assert.ok(final.counts.instances > 100, "expected a multi-instance crossbar hierarchy");
  const snaps = await api("GET", `/api/projects/${project.projectId}/snapshots`);
  const sid = snaps[0].snapshotId;
  const roots = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children`);
  assert.equal(roots.records[0].path, "pulp_axi_xbar_top");
  const root = roots.records[0];
  assert.equal(root.moduleName, "pulp_axi_xbar_top");
  assert.ok(root.hasChildren);
  const rootSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${root.definitionSourceId}&instanceId=${root.id}&startLine=1`);
  assert.equal(rootSource.complete, true);
  assert.ok(rootSource.lines.some((l) => l.text.includes("module pulp_axi_xbar_top")));
  assert.equal(rootSource.lines.find((l) => l.line === 5)?.active, false,
    "the package definition is outside the top module scope");
  assert.ok(!rootSource.refs.some((r) => r.kind === "package" && r.label === "axi_pkg"),
    "package-body imports are not clickable while viewing a module");
  const wrapperPkgRef = rootSource.refs.find((r) =>
    r.kind === "package" && r.label === "pulp_axi_example_pkg");
  assert.ok(wrapperPkgRef, "package prefix in the top module is clickable");
  assert.ok(wrapperPkgRef.targetStartByte !== null);
  const pkgSourceId = wrapperPkgRef.targetSourceId ?? rootSource.sourceId;
  const pkgSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${pkgSourceId}&scopeByte=${wrapperPkgRef.targetStartByte}&startLine=1`);
  assert.equal(pkgSource.lines.find((l) => l.line === 5)?.active, true,
    "a package target activates its package scope");
  assert.equal(pkgSource.lines.find((l) => l.line === 47)?.active, false,
    "module code is inactive while viewing the package scope");
  const wrapperImport = pkgSource.refs.find((r) => r.kind === "package" && r.label === "axi_pkg");
  assert.ok(wrapperImport, "import inside a package body is clickable without a module context");
  const pkgStructRef = pkgSource.refs.find((r) =>
    r.kind === "type" && r.label === "slv_aw_chan_t" && r.targetLine === 31);
  assert.ok(pkgStructRef, "a package struct generated by a macro references another struct typedef");
  const sameFileType = rootSource.refs.find((r) =>
    r.kind === "type" && r.targetSourceId === rootSource.sourceId &&
    r.targetLine !== null && r.targetLine >= 5 && r.targetLine <= 45);
  assert.ok(sameFileType, "the wrapper exposes a package type in the same file");
  assert.ok(sameFileType.targetStartByte !== null);
  const typeScopeSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${sameFileType.targetSourceId}&instanceId=${root.id}&scopeByte=${sameFileType.targetStartByte}&startLine=1`);
  assert.equal(typeScopeSource.lines.find((l) => l.line === sameFileType.targetLine)?.active, true,
    "a same-file type target activates the package containing it");
  assert.equal(typeScopeSource.lines.find((l) => l.line === 47)?.active, false,
    "the current module is not mixed into a package type target view");
  const topSearch = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/search?q=top`);
  assert.ok(topSearch.records.some((r) => r.path === "pulp_axi_xbar_top"));
  assert.ok(topSearch.total < 10,
    `plain "top" search must not match every descendant through the root path prefix (got ${topSearch.total})`);
  const children = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children?parentId=${root.id}`);
  assert.ok(children.records.length >= 1);
  assert.equal(children.records[0].moduleName, "axi_xbar");
  const childSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${children.records[0].definitionSourceId}&instanceId=${children.records[0].id}&startLine=1`);
  assert.equal(childSource.complete, true);
  assert.ok(childSource.activeRegions.some((r) => r.kind === "module" && r.label === "axi_xbar"));
  assert.equal(childSource.lines.find((l) => l.line === 158)?.active, false,
    "axi_xbar_intf is outside the axi_xbar module scope");
  const importPkg = childSource.refs.find((r) => r.kind === "package" && r.label === "cc_pkg");
  assert.ok(importPkg, "package name in import is clickable");
  const importItem = childSource.refs.find((r) => r.kind === "import" && r.label === "cc_pkg::idx_width");
  assert.ok(importItem, "explicitly imported item is clickable");
  assert.equal(importItem.targetLine, 43);

  // Repeated generate blocks produce distinct drivers for each bit range.
  const arbPath = "pulp_axi_xbar_top.i_xbar.gen_mst_port_mux[1].i_axi_mux.gen_mux.i_aw_arbiter";
  const arbSearch = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/search?q=${encodeURIComponent(arbPath)}`);
  const arb = arbSearch.records.find((r) => r.path === arbPath);
  assert.ok(arb, "arbiter instance is in the hierarchy");
  const arbPorts = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/inspector?instanceId=${arb.id}&tab=ports`);
  const gntPort = arbPorts.records.find((r) => r.name === "gnt_o");
  assert.ok(gntPort, "arbiter exposes gnt_o");
  const gntDrivers = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/drivers?instanceId=${arb.id}&symbolId=${gntPort.symbolId}`);
  const gntBits = new Set();
  for (const record of gntDrivers.records) {
    for (let bit = record.targetBitLo; bit <= record.targetBitHi; bit++) gntBits.add(bit);
  }
  assert.deepEqual([...gntBits].sort((a, b) => a - b), [0, 1, 2, 3],
    "all four gnt_o bits have drivers from both generate iterations");
  assert.ok(new Set(gntDrivers.records.map((r) => r.sourceInstanceId)).size >= 2,
    "gnt_o drivers come from both gen_level[0] and gen_level[1] iterations");

  // Parameter struct member selection (Cfg.NoSlvPorts) is visible and jumps
  // like the base parameter.
  const unmuxedPath = "pulp_axi_xbar_top.i_xbar.i_xbar_unmuxed";
  const unmuxedSearch = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/search?q=${encodeURIComponent(unmuxedPath)}`);
  const unmuxed = unmuxedSearch.records.find((r) => r.path === unmuxedPath);
  assert.ok(unmuxed, "i_xbar_unmuxed is in the hierarchy");
  const unmuxedSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${unmuxed.definitionSourceId}&instanceId=${unmuxed.id}&startLine=1`);
  const mstReqLine = unmuxedSource.lines.find((l) => l.text.includes("mst_ports_req_o"));
  assert.ok(mstReqLine && mstReqLine.text.includes("Cfg.NoSlvPorts"));
  const lineTextAt = (r) => mstReqLine.text.slice(r.startByte - mstReqLine.startByte, r.endByte - mstReqLine.startByte);
  const memberRef = unmuxedSource.refs.find((r) => r.kind === "member" &&
    r.startByte >= mstReqLine.startByte && r.startByte < mstReqLine.endByte && lineTextAt(r) === "NoSlvPorts");
  assert.ok(memberRef, "Cfg.NoSlvPorts member token has an occurrence");
  assert.match(memberRef.label ?? "", /^NoSlvPorts = 32'd4$/, "member occurrence carries its evaluated value");
  const memberHover = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${memberRef.occurrenceId}&instanceId=${unmuxed.id}`);
  assert.equal(memberHover.status, "resolved");
  assert.equal(memberHover.kind, "member");
  assert.equal(memberHover.title, "member NoSlvPorts");
  assert.equal(memberHover.actualValue, "32'd4");
  const cfgAt = mstReqLine.startByte + Buffer.byteLength(
    mstReqLine.text.slice(0, mstReqLine.text.indexOf("Cfg.NoSlvPorts")), "utf8");
  const memberAt = cfgAt + Buffer.byteLength("Cfg.", "utf8");
  const cfgResolved = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${unmuxedSource.sourceId}&instanceId=${unmuxed.id}&byteOffset=${cfgAt}`);
  const memberResolved = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${unmuxedSource.sourceId}&instanceId=${unmuxed.id}&byteOffset=${memberAt}`);
  assert.equal(memberResolved.targetKind, "symbol");
  assert.equal(memberResolved.targetSourceId, cfgResolved.targetSourceId,
    "member jumps to the same source as its base parameter");
  assert.equal(memberResolved.targetLine, cfgResolved.targetLine);
  assert.equal(memberResolved.targetInstanceId, cfgResolved.targetInstanceId);

  // Package-qualified port types link both the package prefix and the type.
  const reqPortLine = rootSource.lines.find((l) => l.text.includes("slv_ports_req_i"));
  assert.ok(reqPortLine && reqPortLine.text.includes("pulp_axi_example_pkg::slv_req_t"));
  const reqTypeRef = rootSource.refs.find((r) => r.kind === "type" &&
    r.startByte >= reqPortLine.startByte && r.startByte < reqPortLine.endByte &&
    reqPortLine.text.slice(r.startByte - reqPortLine.startByte, r.endByte - reqPortLine.startByte) === "slv_req_t");
  assert.ok(reqTypeRef, "the type name after a package qualifier is a link");
  assert.equal(reqTypeRef.targetSourceId, rootSource.sourceId);
  assert.equal(reqTypeRef.targetLine, 40);
  const rulePortLine = rootSource.lines.find((l) => l.text.includes("addr_map_i"));
  const rulePortType = rootSource.refs.find((r) => r.kind === "type" &&
    r.startByte >= rulePortLine.startByte && r.startByte < rulePortLine.endByte &&
    rulePortLine.text.slice(r.startByte - rulePortLine.startByte, r.endByte - rulePortLine.startByte) === "rule_t");
  assert.ok(rulePortType, "package-qualified rule_t port type is a link");
  assert.equal(rulePortType.targetLine, 44);

  // Member selection followed by a slice keeps the member link and reports
  // the selected bit value.
  const childInstanceId = children.records[0].id;
  const spillLine = childSource.lines.find((l) => l.text.includes("Cfg.LatencyMode[4]"));
  assert.ok(spillLine);
  const latencyRef = childSource.refs.find((r) => r.kind === "member" &&
    r.startByte >= spillLine.startByte && r.startByte < spillLine.endByte &&
    spillLine.text.slice(r.startByte - spillLine.startByte, r.endByte - spillLine.startByte) === "LatencyMode");
  assert.ok(latencyRef, "Cfg.LatencyMode[4] still exposes the member token");
  assert.match(latencyRef.label ?? "", /^LatencyMode = 1'b1$/);
  const latencyHover = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${latencyRef.occurrenceId}&instanceId=${childInstanceId}`);
  assert.equal(latencyHover.kind, "member");
  assert.equal(latencyHover.title, "member LatencyMode");
  assert.equal(latencyHover.actualValue, "1'b1",
    "the hover value is the selected slice, not just the whole field");
  const spillCfgAt = spillLine.startByte + Buffer.byteLength(
    spillLine.text.slice(0, spillLine.text.indexOf("Cfg.LatencyMode")), "utf8");
  const spillMemberAt = spillCfgAt + Buffer.byteLength("Cfg.", "utf8");
  const spillCfg = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${childSource.sourceId}&instanceId=${childInstanceId}&byteOffset=${spillCfgAt}`);
  const spillMember = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${childSource.sourceId}&instanceId=${childInstanceId}&byteOffset=${spillMemberAt}`);
  assert.equal(spillMember.targetSourceId, spillCfg.targetSourceId);
  assert.equal(spillMember.targetLine, spillCfg.targetLine);
  assert.equal(spillMember.targetInstanceId, spillCfg.targetInstanceId);

  // A type parameter use links to the parameter symbol, so "go to
  // definition" resolves to the parameter declaration rather than the
  // parent override expression.
  const awMuxPath = "pulp_axi_xbar_top.i_xbar.gen_mst_port_mux[1].i_axi_mux";
  const awMuxSearch = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/search?q=${encodeURIComponent(awMuxPath)}`);
  const awMux = awMuxSearch.records.find((r) => r.path === awMuxPath);
  assert.ok(awMux, "axi_mux instance is in the hierarchy");
  const awMuxSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${awMux.definitionSourceId}&instanceId=${awMux.id}&startLine=1`);
  const awMuxDeclLine = awMuxSource.lines.find((l) => l.line === 31);
  const awMuxUseLine = awMuxSource.lines.find((l) => l.line === 220);
  const refText = (line, ref) => line.text.slice(ref.startByte - line.startByte, ref.endByte - line.startByte);
  const awMuxDecl = awMuxSource.refs.find((r) => r.role === "declaration" &&
    r.startByte >= awMuxDeclLine.startByte && r.startByte < awMuxDeclLine.endByte &&
    refText(awMuxDeclLine, r) === "slv_aw_chan_t");
  const awMuxUse = awMuxSource.refs.find((r) => r.kind === "type" &&
    r.startByte >= awMuxUseLine.startByte && r.startByte < awMuxUseLine.endByte &&
    refText(awMuxUseLine, r) === "slv_aw_chan_t");
  assert.ok(awMuxDecl && awMuxUse);
  assert.equal(awMuxUse.targetKind, "symbol", "type parameter use links to a symbol");
  assert.equal(awMuxUse.targetSymbolKind, "type_parameter");
  assert.equal(awMuxUse.targetId, awMuxDecl.targetId, "use and declaration share the type parameter symbol");
  const awMuxDef = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/definition?symbolId=${awMuxUse.targetId}`);
  assert.equal(awMuxDef.status, "resolved");
  assert.equal(awMuxDef.sourceId, awMuxSource.sourceId);
  assert.equal(awMuxDef.line, 31, "definition jumps to the parameter declaration, not the override");
  const awMuxParams = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/inspector?instanceId=${awMux.id}&tab=params`);
  const spillAw = awMuxParams.records.find((r) => r.name === "SpillAw");
  const spillW = awMuxParams.records.find((r) => r.name === "SpillW");
  assert.equal(spillAw.defaultValue, "1'b1");
  assert.equal(spillAw.actualValue, "1'b1", "the override evaluates to the same value as the default");
  assert.equal(spillW.defaultValue, "1'b0");
  assert.equal(spillW.actualValue, "1'b1");

  // Type parameter defaults and overrides come from the right sides.
  const child = children.records[0];
  const paramsPage = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/inspector?instanceId=${child.id}&tab=params`);
  const chanParam = paramsPage.records.find((r) => r.name === "slv_aw_chan_t");
  assert.ok(chanParam, "i_xbar exposes its type parameters");
  assert.equal(chanParam.kind, "type_parameter");
  assert.equal(chanParam.defaultValue, "logic", "default is the declaration-site type");
  assert.equal(chanParam.actualValue, "pulp_axi_example_pkg::slv_aw_chan_t",
    "actual is the parent instantiation override");
  assert.equal(chanParam.typeText, "pulp_axi_example_pkg::slv_aw_chan_t");
  const cfgParam = paramsPage.records.find((r) => r.name === "Cfg");
  assert.ok(cfgParam);
  assert.equal(cfgParam.defaultValue, "'0");
  assert.match(cfgParam.actualValue, /^332'd/);

  const typeParamLine = childSource.lines.find((l) => l.line === 28);
  assert.ok(typeParamLine && typeParamLine.text.includes("slv_aw_chan_t"));
  const typeParamNameAt = typeParamLine.startByte + Buffer.byteLength(
    typeParamLine.text.slice(0, typeParamLine.text.indexOf("slv_aw_chan_t")), "utf8");
  const typeParamResolved = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${childSource.sourceId}&instanceId=${child.id}&byteOffset=${typeParamNameAt}`);
  assert.equal(typeParamResolved.status, "resolved");
  assert.equal(typeParamResolved.targetKind, "symbol");
  assert.equal(typeParamResolved.targetSymbolKind, "type_parameter");
  assert.equal(typeParamResolved.targetSourceId, rootSource.sourceId);
  assert.equal(typeParamResolved.targetLine, 63,
    "clicking the declaration jumps to the parent type override expression");
  assert.equal(typeParamResolved.targetInstanceId, root.id);

  const typeUseLine = childSource.lines.find((l) => l.line === 122);
  assert.ok(typeUseLine && typeUseLine.text.includes("slv_aw_chan_t"));
  const typeUseAt = typeUseLine.startByte + Buffer.byteLength(
    typeUseLine.text.slice(0, typeUseLine.text.lastIndexOf("slv_aw_chan_t")), "utf8");
  const typeUseResolved = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${childSource.sourceId}&instanceId=${child.id}&byteOffset=${typeUseAt}`);
  assert.equal(typeUseResolved.status, "resolved");
  assert.equal(typeUseResolved.targetKind, "symbol");
  assert.equal(typeUseResolved.targetSymbolKind, "type_parameter");
  assert.equal(typeUseResolved.targetSourceId, rootSource.sourceId);
  assert.equal(typeUseResolved.targetLine, 63,
    "a type parameter use still follows the instance override for left click");
  assert.equal(typeUseResolved.targetInstanceId, root.id);

  // Type-parameter overrides carry both the package prefix and the type link.
  const chanLine = rootSource.lines.find((l) => l.text.includes(".slv_aw_chan_t"));
  assert.ok(chanLine);
  const chanRefs = rootSource.refs.filter((r) => r.startByte >= chanLine.startByte && r.startByte < chanLine.endByte);
  const chanPkg = chanRefs.find((r) => r.kind === "package" && r.label === "pulp_axi_example_pkg");
  assert.ok(chanPkg, "package prefix in a type override is clickable");
  const chanType = chanRefs.find((r) => r.kind === "type" && r.label === "slv_aw_chan_t");
  assert.ok(chanType, "type argument in a type override is clickable");
  const chanTarget = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${chanType.targetSourceId}&startLine=1`);
  assert.match(chanTarget.displayPath, /pulp_axi_xbar_top\.sv$/);
  assert.equal(chanType.targetLine, 31);
  const ruleLine = rootSource.lines.find((l) => l.text.includes(".rule_t") && l.text.includes("pulp_axi_example_pkg::rule_t"));
  assert.ok(ruleLine);
  const ruleType = rootSource.refs.find((r) => r.kind === "type" && r.label === "rule_t" &&
    r.startByte >= ruleLine.startByte && r.startByte < ruleLine.endByte);
  assert.ok(ruleType, "rule_t type override is clickable");
  assert.equal(ruleType.targetLine, 44);

  // Find a generated axi_id_prepend and verify port/internal-net alias loads.
  const queue = [root.id];
  const seen = new Set();
  let prepend = null;
  let multicut = null;
  let mux = null;
  while (queue.length > 0 && (!prepend || !multicut || !mux)) {
    const parent = queue.shift();
    if (seen.has(parent) || seen.size > 1200) continue;
    seen.add(parent);
    const page = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children?parentId=${parent}`);
    for (const node of page.records) {
      if (!prepend && node.moduleName === "axi_id_prepend") prepend = node;
      if (!multicut && node.moduleName === "axi_multicut") multicut = node;
      if (!mux && node.moduleName === "axi_mux") mux = node;
      if (node.hasChildren) queue.push(node.id);
    }
  }
  assert.ok(prepend, "expected a generated axi_id_prepend instance");
  const prependAncestors = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/ancestors?instanceId=${prepend.id}`);
  assert.ok(prependAncestors.some((n) => n.kind === "generate_array" || n.kind === "generate_iter"), "prepend instance is inside generate scopes");
  const prependSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${prepend.definitionSourceId}&instanceId=${prepend.id}&startLine=1`);
  const port = prependSource.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith("slv_aw_chans_i"));
  assert.ok(port, "slv_aw_chans_i is indexed");
  assert.equal(port.targetSymbolKind, "port");
  const portLoads = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/loads?instanceId=${prepend.id}&symbolId=${port.targetId}`);
  assert.ok(portLoads.records.length > 0, "port alias exposes internal-net loads");
  const portDrivers = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/drivers?instanceId=${prepend.id}&symbolId=${port.targetId}`);
  assert.ok(portDrivers.records.length > 0, "port alias exposes drivers");
  const portHover = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${port.occurrenceId}&instanceId=${prepend.id}`);
  assert.equal(portHover.title, "port");
  assert.match(portHover.sourceLine, /slv_aw_chans_i/);

  // A reference in a generate-if condition must resolve to the parameter.
  assert.ok(multicut, "expected a generated axi_multicut instance");
  const multiSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${multicut.definitionSourceId}&instanceId=${multicut.id}&startLine=1`);
  const condLine = multiSource.lines.find((l) => l.text.includes("if (NoCuts"));
  assert.ok(condLine, "axi_multicut generate condition is visible");
  const noCutsCol = condLine.text.indexOf("NoCuts");
  const noCutsRef = multiSource.refs.find((r) => r.startByte === condLine.startByte + noCutsCol);
  assert.ok(noCutsRef, "NoCuts in a generate condition is an occurrence");
  assert.equal(noCutsRef.kind, "symbol");
  assert.equal(noCutsRef.targetSymbolKind, "parameter");
  assert.ok(noCutsRef.targetSourceId, "NoCuts has a navigation target");
  const noCutsTarget = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${noCutsRef.targetSourceId}&startLine=1`);
  assert.match(noCutsTarget.lines.find((l) => l.line === noCutsRef.targetLine)?.text ?? "", /NoCuts/);
  const noCutsHover = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${noCutsRef.occurrenceId}&instanceId=${multicut.id}`);
  assert.equal(noCutsHover.kind, "parameter");

  // Duplicate instance bodies are deduplicated by slang's analysis; drivers
  // must still be available on a non-canonical instance.
  const idPrepPath = "gen_mst_port_mux[2].i_axi_mux.gen_mux.gen_id_prepend[3].i_id_prepend";
  const idPrepSearch = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/search?q=${encodeURIComponent(idPrepPath)}`);
  const idPrep = idPrepSearch.records.find((r) => r.path.endsWith(idPrepPath));
  assert.ok(idPrep, "non-canonical axi_id_prepend instance is present");
  const idPrepSrc = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${idPrep.definitionSourceId}&instanceId=${idPrep.id}&startLine=1`);
  const readiesPort = idPrepSrc.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith("slv_aw_readies_o"));
  assert.ok(readiesPort, "axi_id_prepend slv_aw_readies_o is indexed");
  const readiesDrivers = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/drivers?instanceId=${idPrep.id}&symbolId=${readiesPort.targetId}`);
  const readiesContinuous = readiesDrivers.records.find((r) => r.kind === "continuous");
  assert.ok(readiesContinuous, "non-canonical instance exposes its continuous driver");
  assert.equal(readiesContinuous.line, 103);
  const readiesTarget = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${readiesContinuous.sourceId}&instanceId=${idPrep.id}&startLine=1`);
  assert.match(readiesTarget.displayPath, /axi_id_prepend\.sv$/);
  assert.match(readiesTarget.lines.find((l) => l.line === 103)?.text ?? "", /assign slv_aw_readies_o/);

  // A port actual can itself be the first driver; Trace must retain the
  // distinct child-port record so the UI can jump somewhere visible.
  const xbarSource = childSource;
  const xbarLine112 = xbarSource.lines.find((l) => l.line === 112);
  assert.ok(xbarLine112);
  const mstReqRef = xbarSource.refs.find((r) =>
    r.startByte >= xbarLine112.startByte && r.startByte < xbarLine112.endByte &&
    (r.label || "").endsWith("mst_reqs"));
  assert.ok(mstReqRef, "mst_reqs actual at axi_xbar line 112 is clickable");
  const mstReqDrivers = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/drivers?instanceId=${children.records[0].id}&symbolId=${mstReqRef.targetId}`);
  assert.ok(mstReqDrivers.records.length >= 1);
  assert.ok(mstReqDrivers.records.some((r) => r.kind === "port"), "child output port is the real driver");
  assert.ok(!mstReqDrivers.records.some((r) =>
    r.sourceId === xbarSource.sourceId && r.startByte === mstReqRef.startByte && r.endByte === mstReqRef.endByte),
  "port-connection self driver is excluded from jump candidates");

  // Module-body driver visibility from inside a generate scope: port drivers
  // created from parent connections must carry the child body id.
  assert.ok(mux, "expected an axi_mux instance");
  const muxKids = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children?parentId=${mux.id}`);
  const muxGen = muxKids.records.find((n) => n.kind === "generate" && n.name === "gen_mux");
  assert.ok(muxGen, "axi_mux exposes its generate scope");
  const muxSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${mux.definitionSourceId}&instanceId=${muxGen.id}&startLine=1`);
  const muxPort = muxSource.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith("slv_reqs_i"));
  assert.ok(muxPort, "axi_mux slv_reqs_i port is indexed");
  const genScopeDrivers = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/drivers?instanceId=${muxGen.id}&symbolId=${muxPort.targetId}`);
  assert.ok(genScopeDrivers.records.length > 0, "port driver is visible from a generate scope");
  const moduleScopeDrivers = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/drivers?instanceId=${mux.id}&symbolId=${muxPort.targetId}`);
  assert.ok(moduleScopeDrivers.records.length > 0, "port driver is visible from the module scope");
  const respPort = muxSource.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith("slv_resps_o"));
  assert.ok(respPort, "axi_mux slv_resps_o port is indexed");
  const genScopeLoads = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/loads?instanceId=${muxGen.id}&symbolId=${respPort.targetId}`);
  assert.ok(genScopeLoads.records.length > 0, "output-port loads are visible from a generate scope");

  const sessionSnapshotDir = path.join(currentSessionDir(PROJECT), "snapshots", sid);
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionSnapshotDir, "manifest.json"), "utf8"));
  assert.ok(manifest.sources.some((s) => s.displayPath.endsWith("axi_xbar.sv")));
  assert.ok(manifest.sources.some((s) => s.displayPath.endsWith("axi_pkg.sv")));
  assert.ok(manifest.sources.some((s) => s.displayPath.endsWith("pulp_axi_xbar_top.sv")));
  const typedefSrc = manifest.sources.find((s) => s.displayPath.endsWith("axi/typedef.svh"));
  assert.ok(typedefSrc);
  const typedefSource = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${typedefSrc.sourceId}&instanceId=${root.id}&startLine=1`);
  const lenRef = typedefSource.refs.find((r) => r.kind === "type" && r.label === "len_t");
  assert.ok(lenRef, "macro-body struct fields in typedef.svh expose type references");
  assert.equal(lenRef.targetLine, 60);
  const lenResolved = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/resolve?sourceId=${typedefSrc.sourceId}&instanceId=${root.id}&byteOffset=${lenRef.startByte}`);
  assert.equal(lenResolved.targetLine, 60, "typedef.svh type references resolve even from a module context");
  assert.equal(lenResolved.status, "resolved");
  assert.ok(typedefSource.refs.some((r) => r.kind === "package" && r.label === "axi_pkg"));
  const rrSrc = manifest.sources.find((s) => s.displayPath.endsWith("cc_rr_arb_tree.sv"));
  assert.ok(rrSrc);
  const arbBase = "pulp_axi_xbar_top.i_xbar.gen_mst_port_mux[0].i_axi_mux.gen_mux.i_aw_arbiter.gen_arbiter";
  async function instanceAt(path) {
    const found = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/search?q=${encodeURIComponent(path)}`);
    const rec = found.records.find((r) => r.path === path);
    assert.ok(rec, `instance not found: ${path}`);
    return rec;
  }
  async function sourceAt(path) {
    const rec = await instanceAt(path);
    return api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${rrSrc.sourceId}&instanceId=${rec.id}&startLine=1`);
  }
  const lineActive = (win, line) => win.lines.find((l) => l.line === line)?.active;
  const mask0 = await sourceAt(`${arbBase}.gen_int_rr.gen_fair_arb.gen_mask[0]`);
  const mask1 = await sourceAt(`${arbBase}.gen_int_rr.gen_fair_arb.gen_mask[1]`);
  assert.equal(lineActive(mask0, 176), true, "gen_mask[0] uses the if branch");
  assert.equal(lineActive(mask0, 179), false, "gen_mask[0] grays the else branch");
  assert.equal(lineActive(mask1, 176), false, "gen_mask[1] grays the if branch");
  assert.equal(lineActive(mask1, 179), true, "gen_mask[1] uses the else branch");
  const level0 = await sourceAt(`${arbBase}.gen_levels[0]`);
  const level1 = await sourceAt(`${arbBase}.gen_levels[1]`);
  assert.equal(lineActive(level0, 226), false, "gen_levels[0] grays the gen_first_level branch");
  assert.equal(lineActive(level0, 255), true, "gen_levels[0] keeps gen_other_levels active");
  assert.equal(lineActive(level1, 226), true, "gen_levels[1] keeps gen_first_level active");
  assert.equal(lineActive(level1, 255), false, "gen_levels[1] grays the gen_other_levels branch");
  async function levelValueAt(path) {
    const rec = await instanceAt(path);
    const win = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${rrSrc.sourceId}&instanceId=${rec.id}&startLine=1`);
    const ref = win.refs.find((r) => r.kind === "symbol" && (r.label || "").endsWith(" level"));
    assert.ok(ref, `level genvar occurrence missing at ${path}`);
    return api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hover?occurrenceId=${ref.occurrenceId}&instanceId=${rec.id}`);
  }
  const level0Hover = await levelValueAt(`${arbBase}.gen_levels[0]`);
  const level1ParentHover = await levelValueAt(`${arbBase}.gen_levels[1]`);
  const level1Hover = await levelValueAt(`${arbBase}.gen_levels[1].gen_level[0].gen_first_level`);
  assert.equal(level0Hover.actualValue, "0", "gen_levels[0] sees level=0");
  assert.equal(level1ParentHover.actualValue, "1", "gen_levels[1] sees level=1");
  assert.equal(level1Hover.actualValue, "1", "nested scopes inherit the gen_levels[1] value");
  assert.equal(hashTree(PROJECT), sourceBefore, "pulp-axi example source changed");
  const metrics = {
    design: "pulp-platform/axi 4x4 AXI4+ATOP crossbar",
    upstreamCommit: "70b8e54fd460e3308e58be596ceb3566a6e3576e",
    commonCellsCommit: "db42769334b4589b4b3fc671b34513bdb98be565",
    techCellsCommit: "55cb54513e2d426be5992d311cb9d5dbcad10c78",
    buildSeconds: Number(buildSeconds.toFixed(3)),
    snapshotBytes: dirSize(sessionSnapshotDir),
    counts: final.counts,
    generateScopes: final.counts.generateScopes ?? 0,
    diagnostics: final.diagnostics,
    note: "example project smoke; interface port semantics are not claimed",
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(metrics, null, 2) + "\n");
  fs.writeFileSync(EVIDENCE_LATEST, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`pulp-axi-smoke: PASS ${JSON.stringify(metrics)}`);
} finally {
  server.kill("SIGTERM");
  await sleep(500);
  fs.rmSync(STATE, { recursive: true, force: true });
}
