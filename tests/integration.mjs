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
import { stopServer, workerExecutable } from "./lib/platform.mjs";

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT) : path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "dist", "server", "apps", "server", "src", "main.js");
const WORKER = workerExecutable(ROOT);
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const STATE = path.join(ROOT, "state", `integration-${Date.now()}-${process.pid}`);
const HOST = "127.0.0.1";
const ENV_PROJECT = path.join(STATE, "projects", "env");
const ENV_EXTERNAL = path.join(STATE, "external");

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

fs.mkdirSync(ENV_PROJECT, { recursive: true });
fs.mkdirSync(ENV_EXTERNAL, { recursive: true });
fs.mkdirSync(path.join(ENV_PROJECT, "rtl"), { recursive: true });
fs.mkdirSync(path.join(ENV_PROJECT, "lists"), { recursive: true });
fs.copyFileSync(path.join(FIXTURES, "simple", "leaf.sv"), path.join(ENV_PROJECT, "rtl", "leaf.sv"));
fs.copyFileSync(path.join(FIXTURES, "simple", "top.sv"), path.join(ENV_EXTERNAL, "top.sv"));
fs.writeFileSync(path.join(ENV_PROJECT, "lists", "design.f"), "-f lists/leaf.f\n$RTL_EXT_ROOT/top.sv\n");
fs.writeFileSync(path.join(ENV_PROJECT, "lists", "leaf.f"), "rtl/leaf.sv\n");
const envHash = hashTree(ENV_PROJECT);
const externalHash = hashTree(ENV_EXTERNAL);

const server = spawn(process.execPath, [
  MAIN, "--workspace", STATE, "--worker", WORKER,
  "--web", path.join(ROOT, "dist", "web"), "--port", "0",
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RTL_PROJECT_ROOT: ROOT, RTL_TEST_ROOT: ENV_PROJECT, RTL_EXT_ROOT: ENV_EXTERNAL },
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
assert.equal(boot.status, 303);
const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
assert.match(cookie, /^rtl_sid_\d+=/);
const session = await fetch(`${base}/api/session`, { headers: { cookie } }).then((r) => r.json());
assert.equal(session.ok, true);
const csrf = session.data.csrfToken;
const origin = base;

async function api(method, p, body) {
  const headers = { cookie, origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-rtl-csrf"] = csrf;
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json();
  return { status: res.status, body: j };
}
async function ok(method, p, body) {
  const r = await api(method, p, body);
  if (!r.body.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
const hashes = new Map();
function copyFixture(name, fixture) {
  const dir = path.join(STATE, "projects", `${name}-${crypto.randomBytes(3).toString("hex")}`);
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true, filter: (src) => path.basename(src) !== ".rtlb" });
  hashes.set(dir, hashTree(dir));
  return dir;
}
async function createProject(name, fixture, extra = {}, dirOverride = null) {
  const dir = dirOverride ?? copyFixture(name, fixture);
  await ok("POST", "/api/workspace/open", { path: dir });
  const topModule = extra.topModule ?? (fixture === "simple" || fixture === "preprocess" ? "top" : fixture);
  const config = {
    inputMode: "filelist", filelistPath: extra.filelistPath ?? "design.f",
    topMode: "explicit", topModule,
    defines: [], includeRoots: [], libraries: [], parameters: [],
    language: "1800-2017", singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
    ...extra,
  };
  const data = await ok("POST", "/api/projects", { config });
  return { project: data.project, config: data.config, dir };
}
function currentSessionDir(projectRoot) {
  const sessions = path.join(projectRoot, ".rtlb", "sessions");
  const dirs = fs.readdirSync(sessions).filter((name) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessions, name, "session.json"), "utf8"));
      return meta.pid === server.pid;
    } catch { return false; }
  });
  assert.equal(dirs.length, 1, `expected one live session directory under ${sessions}`);
  return path.join(sessions, dirs[0]);
}
async function download(p) {
  const res = await fetch(`${base}${p}`, { headers: { cookie } });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}
async function importBundle(dir, body) {
  await ok("POST", "/api/workspace/open", { path: dir });
  const res = await fetch(`${base}/api/workspace/snapshot/import`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/octet-stream", "x-rtl-csrf": csrf },
    body,
  });
  return { status: res.status, body: await res.json() };
}
function bundleHeader(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("ascii"), "RTLSNAP1");
  const len = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(48, 48 + len).toString("utf8"));
  return { len, header };
}
function rewriteBundleHeader(buffer, mutate) {
  const { len, header } = bundleHeader(buffer);
  mutate(header);
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const preamble = Buffer.from(buffer.subarray(0, 16));
  preamble.writeUInt32LE(headerBytes.length, 12);
  const hash = crypto.createHash("sha256").update(headerBytes).digest();
  return Buffer.concat([preamble, hash, headerBytes, buffer.subarray(48 + len)]);
}
async function build(projectId, key, revision = 1) {
  const job = await ok("POST", `/api/projects/${projectId}/build`, { configRevision: revision, requestKey: key });
  let last = null;
  for (let i = 0; i < 300; i++) {
    last = await ok("GET", `/api/projects/${projectId}/jobs/${job.jobId}`);
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(last.state)) {
      if (last.state === "FAILED" && process.env.RTL_TEST_VERBOSE_FAILURES === "1") {
        console.error("build failed:", JSON.stringify(last), "\nserver stderr:\n" + stderr);
      }
      return { ...last, purged: job.purged };
    }
    await sleep(100);
  }
  throw new Error(`build did not finish: ${JSON.stringify(last)}\n${stderr}`);
}

try {
  // 1. simple project: hierarchy, params, port actuals, loads
  const simple = await createProject("simple-it", "simple");
  const simpleJob = await build(simple.project.projectId, "it-simple-1");
  assert.equal(
    simpleJob.state,
    "COMPLETE",
    JSON.stringify(simpleJob, null, 2) + "\nserver stderr:\n" + stderr,
  );
  assert.equal(simpleJob.diagnostics.error, 0);
  const snaps = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots`);
  assert.equal(snaps.length, 1);
  const sid = snaps[0].snapshotId;
  const sessionDir = currentSessionDir(simple.dir);
  const snapshotsDir = path.join(sessionDir, "snapshots");
  const reopenedSimple = await ok("POST", "/api/workspace/open", { path: simple.dir });
  assert.equal(reopenedSimple.snapshot.snapshotId, sid);
  assert.equal(reopenedSimple.project.projectId, simple.project.projectId, "same server session resumes its project");
  const beforeCheck = await ok("GET", `/api/projects/${simple.project.projectId}`);
  const draftCheck = await ok("POST", "/api/workspace/validate", { config: {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "top",
    defines: [{ name: "CHECK_ONLY", value: "1" }], includeRoots: [], libraries: [], parameters: [],
    language: null, singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
  } });
  assert.equal(draftCheck.valid, true);
  assert.match(draftCheck.message, /输入检查通过/);
  const afterCheck = await ok("GET", `/api/projects/${simple.project.projectId}`);
  assert.equal(afterCheck.config.configRevision, beforeCheck.config.configRevision, "input check must not save config");
  assert.equal(afterCheck.config.configDigest, beforeCheck.config.configDigest);
  assert.equal((await ok("GET", `/api/projects/${simple.project.projectId}/snapshots`)).length, 1);
  const badCheck = await api("POST", "/api/workspace/validate", { config: {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "",
    defines: [], includeRoots: [], libraries: [], parameters: [], language: null,
    singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
  } });
  assert.equal(badCheck.status, 400);
  assert.equal(badCheck.body.ok, false);
  const manifestPath = path.join(snapshotsDir, sid, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.match(manifest.compilerCommit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.compilerCommit,
    JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "deps", "versions.json"), "utf8")).slangCommit);
  assert.equal(manifest.extractorVersion, "0.9.11");
  const children = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hierarchy/children`);
  const root = children.records[0];
  assert.equal(root.path, "top");
  const hierarchySearch = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hierarchy/search?q=u`);
  assert.ok(hierarchySearch.records.some((r) => r.path === "top.u16"));
  assert.ok(hierarchySearch.records.some((r) => r.path === "top.u8"));
  assert.ok(hierarchySearch.total >= 2, "hierarchy search counts matching nodes");
  assert.equal(hierarchySearch.complete, true);
  const topSearch = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hierarchy/search?q=top`);
  assert.equal(topSearch.total, 1, "plain search does not match every node via the root path prefix");
  assert.equal(topSearch.records[0].path, "top");
  const pathSearch = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hierarchy/search?q=${encodeURIComponent("top.u16")}`);
  assert.ok(pathSearch.records.some((r) => r.path === "top.u16"), "explicit hierarchical query matches paths");
  const noHierarchyMatch = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hierarchy/search?q=does_not_exist`);
  assert.equal(noHierarchyMatch.total, 0);
  const topSource = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/source?sourceId=${root.definitionSourceId}&instanceId=${root.id}&startLine=1`);
  assert.equal(topSource.startLine, 1);
  assert.equal(topSource.complete, true);
  assert.equal(topSource.endLine, topSource.totalLines);
  assert.ok(topSource.lines.some((l) => l.text.includes("assign a8")));
  const a8ref = topSource.refs.find((r) => r.role === "read" && r.label?.includes("a8") && r.label?.endsWith(" a8"));
  assert.ok(a8ref, "a8 read occurrence");
  const instLine = topSource.lines.find((l) => l.line === 12);
  assert.ok(instLine);
  const actualA8 = topSource.refs.find((r) => r.role === "read" && r.label?.endsWith(" a8") && r.startByte >= instLine.startByte);
  assert.ok(actualA8, "port actual a8 is clickable");
  const actualY8 = topSource.refs.find((r) => r.role === "write" && r.label?.endsWith(" y8") && r.startByte >= instLine.startByte);
  assert.ok(actualY8, "output port actual y8 is clickable");
  const actualHover = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hover?occurrenceId=${actualA8.occurrenceId}&instanceId=${root.id}`);
  assert.equal(actualHover.width, 8);
  const topParamRef = topSource.refs.find((r) => r.role === "read" && r.label?.endsWith(" W_TOP") && r.startByte >= instLine.startByte);
  assert.ok(topParamRef, "parent parameter expression is clickable");
  assert.equal(topParamRef.targetKind, "symbol");
  const resolved = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/resolve?sourceId=${root.definitionSourceId}&instanceId=${root.id}&byteOffset=${a8ref.startByte}`);
  assert.equal(resolved.status, "resolved");
  const loads = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/loads?instanceId=${root.id}&symbolId=${a8ref.targetId}`);
  assert.ok(loads.records.some((r) => r.role === "data" && r.targetLabel === "mirror8"));
  assert.ok(loads.records.some((r) => r.role === "port" && r.targetLabel === "a"));
  const kids = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hierarchy/children?parentId=${root.id}`);
  assert.equal(kids.records.length, 2);
  const u8 = kids.records[0];
  const u8src = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/source?sourceId=${u8.definitionSourceId}&instanceId=${u8.id}&startLine=1`);
  assert.equal(u8src.totalLines, 6);
  const u8w = u8src.refs.find((r) => r.role === "declaration" && r.label?.endsWith(" W"));
  assert.ok(u8w, "parameter W is indexed");
  assert.equal(u8w.targetSourceId, String(root.definitionSourceId));
  assert.equal(u8w.targetLine, 12);
  assert.equal(u8w.targetInstanceId, String(root.id));
  const u8Def = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/definition?symbolId=${u8w.targetId}`);
  assert.equal(u8Def.status, "resolved");
  assert.equal(u8Def.sourceId, String(u8.definitionSourceId));
  assert.equal(u8Def.line, 1);
  const u8wh = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hover?occurrenceId=${u8w.occurrenceId}&instanceId=${u8.id}`);
  assert.equal(u8wh.actualValue, "8");
  const u16 = kids.records[1];
  const u16src = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/source?sourceId=${u16.definitionSourceId}&instanceId=${u16.id}&startLine=1`);
  const u16w = u16src.refs.find((r) => r.role === "declaration" && r.label?.endsWith(" W"));
  assert.ok(u16w);
  assert.equal(u16w.targetLine, 13);
  const u16wh = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/hover?occurrenceId=${u16w.occurrenceId}&instanceId=${u16.id}`);
  assert.equal(u16wh.actualValue, "16");
  const u8a = u8src.refs.find((r) => r.role === "declaration" && r.label?.includes("input"));
  assert.ok(u8a);
  const u8drivers = await ok("GET", `/api/projects/${simple.project.projectId}/snapshots/${sid}/drivers?instanceId=${u8.id}&symbolId=${u8a.targetId}`);
  assert.ok(u8drivers.records.length >= 1);

  // 1b. idempotent repeat build
  for (let attempt = 0; attempt < 5; attempt++) {
    const repeat = await build(simple.project.projectId, `it-simple-repeat-${attempt}`);
    assert.equal(repeat.state, "COMPLETE", JSON.stringify(repeat, null, 2) + "\n" + stderr);
    assert.equal(repeat.snapshotId, sid, "identical inputs must publish identical index content");
    assert.ok(!repeat.purged);
  }

  // 1c. project paths containing spaces and non-ASCII characters
  const unicodeDir = path.join(STATE, "projects", "unicode 路径 with space");
  fs.cpSync(path.join(FIXTURES, "simple"), unicodeDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== ".rtlb",
  });
  hashes.set(unicodeDir, hashTree(unicodeDir));
  const unicode = await createProject("unicode-path-it", "simple", {}, unicodeDir);
  const unicodeJob = await build(unicode.project.projectId, "it-unicode-path");
  assert.equal(unicodeJob.state, "COMPLETE", JSON.stringify(unicodeJob));

  if (process.platform === "win32") {
    const winPathDir = copyFixture("windows-path-it", "simple");
    fs.writeFileSync(path.join(winPathDir, "design.f"),
      `"${path.join(winPathDir, "leaf.sv")}"\n"${path.join(winPathDir, "top.sv")}"\n`);
    hashes.set(winPathDir, hashTree(winPathDir));
    const winPath = await createProject("windows-path-it", "simple", {}, winPathDir);
    const winPathJob = await build(winPath.project.projectId, "it-windows-path");
    assert.equal(winPathJob.state, "COMPLETE", JSON.stringify(winPathJob));

    // A junction named .rtlb must not redirect state outside the project.
    const junctionDir = copyFixture("junction-it", "simple");
    const outside = path.join(STATE, "junction-outside");
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(junctionDir, ".rtlb"), "junction");
      const rejected = await api("POST", "/api/workspace/open", { path: junctionDir });
      assert.equal(rejected.body.ok, false, "junction based .rtlb escape must be rejected");
      assert.match(rejected.body.error?.code ?? "", /PERMISSION_DENIED|INVALID_INPUT/);
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : "";
      if (code !== "EPERM" && code !== "EACCES") throw err;
      console.warn("integration: skip junction escape test (cannot create junction)");
    }
  }

  // 1d. large source windows use the source-specific response budget
  const largeDir = path.join(STATE, "projects", `large-source-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(largeDir, { recursive: true });
  const largeLines = ["module big(input logic [31:0] a, output logic [31:0] y);"];
  for (let i = 0; i < 3000; i++) largeLines.push(`  logic [31:0] signal_with_a_rather_long_name_${i};`);
  for (let i = 0; i < 3000; i++) largeLines.push(`  assign signal_with_a_rather_long_name_${i} = a;`);
  largeLines.push("  assign y = signal_with_a_rather_long_name_0;", "endmodule");
  fs.writeFileSync(path.join(largeDir, "design.f"), "big.sv\n");
  fs.writeFileSync(path.join(largeDir, "big.sv"), largeLines.join("\n") + "\n");
  const large = await createProject("large-source-it", "simple", { topModule: "big" }, largeDir);
  const largeJob = await build(large.project.projectId, "it-large-source");
  assert.equal(largeJob.state, "COMPLETE");
  const largeSid = (await ok("GET", `/api/projects/${large.project.projectId}/snapshots`))[0].snapshotId;
  const largeRoot = (await ok("GET", `/api/projects/${large.project.projectId}/snapshots/${largeSid}/hierarchy/children`)).records[0];
  const largeSourcePath = `/api/projects/${large.project.projectId}/snapshots/${largeSid}/source?sourceId=${largeRoot.definitionSourceId}&instanceId=${largeRoot.id}&startLine=1`;
  const largeResponse = await fetch(`${base}${largeSourcePath}`, { headers: { cookie, origin } });
  const largeText = await largeResponse.text();
  assert.equal(largeResponse.status, 200, largeText.slice(0, 300));
  assert.ok(Buffer.byteLength(largeText) > 1_048_576,
    `large source response should exceed the old 1 MiB JSON cap (got ${Buffer.byteLength(largeText)} bytes)`);
  const largePayload = JSON.parse(largeText);
  assert.equal(largePayload.ok, true);
  assert.ok(largePayload.data.refs.length > 0);

  // 2. include / import / type links
  const pre = await createProject("preprocess-it", "preprocess");
  const preJob = await build(pre.project.projectId, "it-preprocess");
  assert.equal(preJob.state, "COMPLETE");
  const preSid = (await ok("GET", `/api/projects/${pre.project.projectId}/snapshots`))[0].snapshotId;
  const preRoot = (await ok("GET", `/api/projects/${pre.project.projectId}/snapshots/${preSid}/hierarchy/children`)).records[0];
  const preSrc = await ok("GET", `/api/projects/${pre.project.projectId}/snapshots/${preSid}/source?sourceId=${preRoot.definitionSourceId}&instanceId=${preRoot.id}&startLine=1`);
  const topType = preSrc.refs.find((r) => r.role === "type" && r.label === "byte_t");
  assert.ok(topType);
  const topTypeTarget = await ok("GET", `/api/projects/${pre.project.projectId}/snapshots/${preSid}/source?sourceId=${topType.targetSourceId}&startLine=1`);
  assert.match(topTypeTarget.displayPath, /pkg\.sv$/);
  const pkgRefs = preSrc.refs.filter((r) => r.kind === "package" && r.label === "p");
  assert.ok(pkgRefs.length >= 2, "both wildcard and explicit imports expose the package name");
  const pkgTarget = await ok("GET", `/api/projects/${pre.project.projectId}/snapshots/${preSid}/source?sourceId=${pkgRefs[0].targetSourceId}&startLine=1`);
  assert.match(pkgTarget.displayPath, /pkg\.sv$/);
  assert.equal(pkgTarget.lines.find((l) => l.line === pkgRefs[0].targetLine)?.text, "package p;");
  const explicitImport = preSrc.refs.find((r) => r.kind === "import" && r.label === "p::byte_t");
  assert.ok(explicitImport, "explicit import item is navigable");
  assert.equal(explicitImport.targetSourceId, topType.targetSourceId);
  assert.equal(explicitImport.targetLine, 2);
  const preKid = (await ok("GET", `/api/projects/${pre.project.projectId}/snapshots/${preSid}/hierarchy/children?parentId=${preRoot.id}`)).records[0];
  const leafSrc = await ok("GET", `/api/projects/${pre.project.projectId}/snapshots/${preSid}/source?sourceId=${preKid.definitionSourceId}&instanceId=${preKid.id}&startLine=1`);
  assert.ok(leafSrc.refs.find((r) => r.role === "type" && r.label === "byte_t"));
  const incRef = leafSrc.refs.find((r) => r.kind === "include");
  assert.ok(incRef);
  const incLine = leafSrc.lines.find((l) => l.startByte <= incRef.startByte && l.endByte > incRef.startByte);
  assert.ok(incLine);
  const incText = incLine.text.slice(incRef.startByte - incLine.startByte, incRef.endByte - incLine.startByte);
  assert.match(incText, /defs\.svh/);
  assert.ok(!incText.includes("include"), "include keyword must not be part of the link span");
  assert.ok(leafSrc.refs.find((r) => r.kind === "macro" && r.label?.includes("WIDTH")));

  // 2b. package-local struct fields reference other typedefs
  const pkgTypes = await createProject("package-types-it", "package-types", { topModule: "top" });
  const pkgTypesJob = await build(pkgTypes.project.projectId, "it-package-types");
  assert.equal(pkgTypesJob.state, "COMPLETE", JSON.stringify(pkgTypesJob));
  const pkgSid = (await ok("GET", `/api/projects/${pkgTypes.project.projectId}/snapshots`))[0].snapshotId;
  const pkgRoot = (await ok("GET", `/api/projects/${pkgTypes.project.projectId}/snapshots/${pkgSid}/hierarchy/children`)).records[0];
  const pkgTopSrc = await ok("GET", `/api/projects/${pkgTypes.project.projectId}/snapshots/${pkgSid}/source?sourceId=${pkgRoot.definitionSourceId}&instanceId=${pkgRoot.id}&startLine=1`);
  const elementTypeRef = pkgTopSrc.refs.find((r) => r.kind === "type" && r.label === "element_t");
  assert.ok(elementTypeRef, "top-level use of a package struct is a type reference");
  const pkgTypesSrc = await ok("GET", `/api/projects/${pkgTypes.project.projectId}/snapshots/${pkgSid}/source?sourceId=${elementTypeRef.targetSourceId}&instanceId=${pkgRoot.id}&scopeByte=${elementTypeRef.targetStartByte}&startLine=1`);
  const nibbleField = pkgTypesSrc.refs.find((r) => r.kind === "type" && r.label === "nibble_t");
  assert.ok(nibbleField, "a package struct field references another typedef");
  assert.equal(nibbleField.targetLine, 2);
  const nibbleLine = pkgTypesSrc.lines.find((l) => l.startByte <= nibbleField.startByte && l.endByte > nibbleField.startByte);
  assert.match(nibbleLine.text, /nibble_t/);
  const elementField = pkgTypesSrc.refs.find((r) =>
    r.kind === "type" && r.label === "element_t" && r.targetLine === 7);
  assert.ok(elementField, "a struct field whose type is another struct is navigable");
  const nibbleResolved = await ok("GET", `/api/projects/${pkgTypes.project.projectId}/snapshots/${pkgSid}/resolve?sourceId=${elementTypeRef.targetSourceId}&instanceId=${pkgRoot.id}&byteOffset=${nibbleField.startByte}`);
  assert.equal(nibbleResolved.targetLine, 2, "package struct field resolves from a module context");

  // 3. environment variables + nested filelists, relative to project root
  const env = await createProject("env-it", "simple", { filelistPath: "$RTL_TEST_ROOT/lists/design.f" }, ENV_PROJECT);
  const envJob = await build(env.project.projectId, "it-env");
  assert.equal(envJob.state, "COMPLETE", JSON.stringify(envJob));
  const envSid = (await ok("GET", `/api/projects/${env.project.projectId}/snapshots`))[0].snapshotId;
  const envRoot = (await ok("GET", `/api/projects/${env.project.projectId}/snapshots/${envSid}/hierarchy/children`)).records[0];
  const envSrc = await ok("GET", `/api/projects/${env.project.projectId}/snapshots/${envSid}/source?sourceId=${envRoot.definitionSourceId}&instanceId=${envRoot.id}&startLine=1`);
  assert.match(envSrc.displayPath, /external\/top\.sv$/);

  // 3b. default parameter, constant actual, generate-scope port edges
  const edge = await createProject("edge-it", "edge", { topModule: "top" });
  const edgeJob = await build(edge.project.projectId, "it-edge");
  assert.equal(edgeJob.state, "COMPLETE");
  const edgeSid = (await ok("GET", `/api/projects/${edge.project.projectId}/snapshots`))[0].snapshotId;
  const edgeRoot = (await ok("GET", `/api/projects/${edge.project.projectId}/snapshots/${edgeSid}/hierarchy/children`)).records[0];
  const edgeTop = await ok("GET", `/api/projects/${edge.project.projectId}/snapshots/${edgeSid}/source?sourceId=${edgeRoot.definitionSourceId}&instanceId=${edgeRoot.id}&startLine=1`);
  const constLine = edgeTop.lines.find((l) => l.text.includes("u_const"));
  assert.ok(constLine);
  const lit = constLine.text.indexOf("1'b0");
  assert.ok(lit >= 0);
  const litByte = constLine.startByte + lit;
  assert.ok(!edgeTop.refs.some((r) => r.startByte <= litByte && r.endByte > litByte), "constant actual must not be clickable");
  const a4decl = edgeTop.refs.find((r) => r.role === "declaration" && r.label?.endsWith(" a4"));
  assert.ok(a4decl);
  const a4loads = await ok("GET", `/api/projects/${edge.project.projectId}/snapshots/${edgeSid}/loads?instanceId=${edgeRoot.id}&symbolId=${a4decl.targetId}`);
  assert.ok(a4loads.records.filter((r) => r.role === "port").length >= 3, "default and generated instances expose port edges");
  const edgeKids = await ok("GET", `/api/projects/${edge.project.projectId}/snapshots/${edgeSid}/hierarchy/children?parentId=${edgeRoot.id}`);
  const uDefault = edgeKids.records.find((r) => r.moduleName === "leaf_default");
  assert.ok(uDefault);
  const defSrc = await ok("GET", `/api/projects/${edge.project.projectId}/snapshots/${edgeSid}/source?sourceId=${uDefault.definitionSourceId}&instanceId=${uDefault.id}&startLine=1`);
  const defW = defSrc.refs.find((r) => r.role === "declaration" && r.label?.endsWith(" W"));
  assert.ok(defW);
  assert.equal(defW.targetSourceId, String(uDefault.definitionSourceId));
  assert.equal(defW.targetLine, 1);
  assert.equal(defW.targetInstanceId, null);
  const defHover = await ok("GET", `/api/projects/${edge.project.projectId}/snapshots/${edgeSid}/hover?occurrenceId=${defW.occurrenceId}&instanceId=${uDefault.id}`);
  assert.equal(defHover.actualValue, "4");

  // 3c. +incdir+ inside a filelist is normalized and honored
  const incDir = copyFixture("incdir-it", "preprocess");
  fs.mkdirSync(path.join(incDir, "inc"), { recursive: true });
  fs.renameSync(path.join(incDir, "defs.svh"), path.join(incDir, "inc", "defs.svh"));
  fs.writeFileSync(path.join(incDir, "design.f"), "+incdir+inc\npkg.sv\nleaf.sv\ntop.sv\n");
  hashes.set(incDir, hashTree(incDir));
  const inc = await createProject("incdir-it", "preprocess", {}, incDir);
  const incJob = await build(inc.project.projectId, "it-incdir");
  assert.equal(incJob.state, "COMPLETE");

  // 3d. generate if/for hierarchy, trace instances, port/internal aliases
  const gen = await createProject("generate-it", "generate", { topModule: "top" });
  const genJob = await build(gen.project.projectId, "it-generate");
  assert.equal(genJob.state, "COMPLETE");
  assert.ok(genJob.counts.generateScopes >= 4);
  const genSid = (await ok("GET", `/api/projects/${gen.project.projectId}/snapshots`))[0].snapshotId;
  const genRoot = (await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hierarchy/children`)).records[0];
  const genKids = (await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hierarchy/children?parentId=${genRoot.id}`)).records;
  const active = genKids.find((r) => r.kind === "generate" && r.name === "active_branch");
  assert.ok(active, "active if-generate branch is a hierarchy node");
  assert.ok(!genKids.some((r) => r.kind === "generate_array" || r.name === "g"),
    "generate for-loop array is flattened");
  assert.ok(!genKids.some((r) => r.name === "inactive_branch" || r.path.includes("inactive_branch")), "inactive branch is absent");
  const activeKids = (await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hierarchy/children?parentId=${active.id}`)).records;
  assert.ok(activeKids.some((r) => r.kind === "instance" && r.moduleName === "leaf"));
  const iterKids = genKids.filter((r) => r.kind === "generate_iter");
  assert.equal(iterKids.length, 3);
  assert.deepEqual(iterKids.map((r) => r.name), ["g[0]", "g[1]", "g[2]"]);
  assert.deepEqual(iterKids.map((r) => r.path), ["top.g[0]", "top.g[1]", "top.g[2]"]);
  const iter0 = iterKids[0];
  const iterKidsInside = (await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hierarchy/children?parentId=${iter0.id}`)).records;
  const uG = iterKidsInside.find((r) => r.kind === "instance" && r.moduleName === "leaf");
  assert.ok(uG);
  const flatSearch = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hierarchy/search?q=${encodeURIComponent("g[1]")}`);
  assert.ok(flatSearch.records.some((r) => r.path === "top.g[1]" && r.name === "g[1]"),
    "flattened iteration is searchable by its display name");
  const ancestors = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hierarchy/ancestors?instanceId=${uG.id}`);
  assert.deepEqual(ancestors.map((r) => r.path), ["top", "top.g[0]", "top.g[0].u_g"]);

  const genTopSrc = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/source?sourceId=${genRoot.definitionSourceId}&instanceId=${genRoot.id}&startLine=1`);
  assert.equal(genTopSrc.activeRegions.find((r) => r.label === "top")?.kind, "module");
  assert.equal(genTopSrc.inactiveRegions.length, 1, "the untaken generate branch is recorded");
  const inactiveBranch = genTopSrc.inactiveRegions[0];
  assert.equal(genTopSrc.lines.find((l) => l.line === 9)?.active, false,
    "code inside the inactive generate branch is inactive");
  assert.equal(genTopSrc.lines.find((l) => l.line === 11)?.active, true,
    "code inside the active generate branch is active");
  assert.ok(genTopSrc.refs.every((r) => r.endByte <= inactiveBranch.startByte || r.startByte >= inactiveBranch.endByte),
    "inactive generate code exposes no semantic references");
  const genA4Decl = genTopSrc.refs.find((r) => r.role === "declaration" && r.label?.endsWith(" a4"));
  assert.ok(genA4Decl);
  assert.ok(["net", "variable", "port"].includes(genA4Decl.targetSymbolKind));
  const genA4Hover = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/hover?occurrenceId=${genA4Decl.occurrenceId}&instanceId=${genRoot.id}`);
  assert.equal(genA4Hover.title, genA4Hover.kind);
  assert.match(genA4Hover.sourceLine, /a4;.*shared input/);
  const genA4Loads = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/loads?instanceId=${genRoot.id}&symbolId=${genA4Decl.targetId}`);
  assert.ok(genA4Loads.records.some((r) => r.sourceInstanceId === iter0.id), "generate assignment carries iteration instance id");

  const uGSrc = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/source?sourceId=${uG.definitionSourceId}&instanceId=${uG.id}&startLine=1`);
  const portA = uGSrc.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith(" a"));
  assert.ok(portA);
  assert.equal(portA.targetSymbolKind, "port");
  const portLoads = await ok("GET", `/api/projects/${gen.project.projectId}/snapshots/${genSid}/loads?instanceId=${uG.id}&symbolId=${portA.targetId}`);
  assert.ok(portLoads.records.length > 0, "port alias exposes internal net loads");

  // 3e. conditional-preprocessor branches are grayed out source-wide, including
  //     nested ifdef/ifndef/elsif selections
  const ifdefLine = (src, text) => {
    const line = src.lines.find((l) => l.text.trim() === text);
    assert.ok(line, `missing source line: ${text}`);
    return line;
  };
  const assertSourceLine = (src, text, active) => {
    const line = ifdefLine(src, text);
    assert.equal(line.active, active, `${text} should be ${active ? "active" : "inactive"}`);
  };
  async function buildIfdef(defines, key, fixture = "ifdef") {
    const project = await createProject("ifdef-it", fixture, { topModule: "top", defines });
    const job = await build(project.project.projectId, key);
    assert.equal(job.state, "COMPLETE", JSON.stringify(job));
    const sid = (await ok("GET", `/api/projects/${project.project.projectId}/snapshots`))[0].snapshotId;
    const root = (await ok("GET", `/api/projects/${project.project.projectId}/snapshots/${sid}/hierarchy/children`)).records[0];
    const src = await ok("GET", `/api/projects/${project.project.projectId}/snapshots/${sid}/source?sourceId=${root.definitionSourceId}&instanceId=${root.id}&startLine=1`);
    return { project: project.project, config: project.config, dir: project.dir, sid, root, src };
  }

  const ifdefA = await buildIfdef([{ name: "ENABLE_A", value: "1" }], "it-ifdef-a");
  for (const text of ["logic a;", "logic b;", "logic f;", "logic last;"]) {
    assertSourceLine(ifdefA.src, text, true);
  }
  for (const text of ["logic e;", "logic c;", "logic h;", "logic g;", "logic d;", "logic i;"]) {
    assertSourceLine(ifdefA.src, text, false);
  }
  assert.equal(ifdefA.src.inactiveRegions.length, 4,
    "one region per unselected preprocessor branch, including nested and elsif branches");
  for (const region of ifdefA.src.inactiveRegions) {
    assert.ok(!ifdefA.src.refs.some((r) => r.startByte < region.endByte && r.endByte > region.startByte),
      `skipped ${region.kind} branch exposes no semantic references`);
  }
  const ifdefGlobal = await ok("GET", `/api/projects/${ifdefA.project.projectId}/snapshots/${ifdefA.sid}/source?sourceId=${ifdefA.root.definitionSourceId}&startLine=1`);
  assertSourceLine(ifdefGlobal, "logic e;", false);
  assertSourceLine(ifdefGlobal, "logic f;", true);
  assertSourceLine(ifdefGlobal, "logic last;", true);

  const ifdefNone = await buildIfdef([], "it-ifdef-none");
  for (const text of ["logic a;", "logic b;", "logic e;", "logic f;", "logic c;",
                      "logic h;", "logic g;", "logic i;"]) {
    assertSourceLine(ifdefNone.src, text, false);
  }
  for (const text of ["logic d;", "logic last;"]) {
    assertSourceLine(ifdefNone.src, text, true);
  }

  const ifdefB = await buildIfdef([
    { name: "ENABLE_A", value: "1" }, { name: "DISABLE_B", value: "1" },
  ], "it-ifdef-ab");
  for (const text of ["logic b;", "logic e;", "logic f;", "logic h;",
                      "logic g;", "logic d;", "logic i;"]) {
    assertSourceLine(ifdefB.src, text, false);
  }
  for (const text of ["logic a;", "logic c;", "logic last;"]) {
    assertSourceLine(ifdefB.src, text, true);
  }

  const ifdefC = await buildIfdef([{ name: "ENABLE_C", value: "1" }], "it-ifdef-c");
  for (const text of ["logic a;", "logic b;", "logic e;", "logic f;", "logic c;",
                      "logic h;", "logic d;", "logic i;"]) {
    assertSourceLine(ifdefC.src, text, false);
  }
  for (const text of ["logic g;", "logic last;"]) {
    assertSourceLine(ifdefC.src, text, true);
  }

  // 16-level nested ifdef/ifndef chain: active outer branches expose every
  // inner else as a separate inactive region, while a skipped outer branch
  // covers its whole nested subtree.
  const oddL = Array.from({ length: 8 }, (_, i) => ({ name: `L${2 * i + 1}`, value: "1" }));
  const deepThen = await buildIfdef(oddL, "it-ifdef-deep-then", "ifdef-deep");
  for (let i = 1; i <= 16; i++) assertSourceLine(deepThen.src, `logic t${i};`, true);
  for (let i = 1; i <= 16; i++) assertSourceLine(deepThen.src, `logic e${i};`, false);
  assertSourceLine(deepThen.src, "logic last;", true);
  assert.equal(deepThen.src.inactiveRegions.length, 16,
    "each unselected else in a 16-level active chain has its own region");
  assert.ok(deepThen.src.refs.every((r) => !deepThen.src.inactiveRegions.some(
    (region) => r.startByte < region.endByte && r.endByte > region.startByte)),
    "a 16-level nested chain exposes no refs in inactive else branches");

  const deepOuter = await buildIfdef([], "it-ifdef-deep-outer", "ifdef-deep");
  for (let i = 1; i <= 16; i++) assertSourceLine(deepOuter.src, `logic t${i};`, false);
  for (let i = 2; i <= 16; i++) assertSourceLine(deepOuter.src, `logic e${i};`, false);
  assertSourceLine(deepOuter.src, "logic e1;", true);
  assertSourceLine(deepOuter.src, "logic last;", true);
  assert.equal(deepOuter.src.inactiveRegions.length, 1,
    "a skipped outer branch covers its 15 nested descendants as one region");

  const deepLast = await buildIfdef([...oddL, { name: "L16", value: "1" }],
    "it-ifdef-deep-last", "ifdef-deep");
  for (let i = 1; i <= 15; i++) assertSourceLine(deepLast.src, `logic t${i};`, true);
  assertSourceLine(deepLast.src, "logic t16;", false);
  assertSourceLine(deepLast.src, "logic e16;", true);
  for (let i = 1; i <= 15; i++) assertSourceLine(deepLast.src, `logic e${i};`, false);
  assert.equal(deepLast.src.inactiveRegions.length, 16,
    "only the deepest unselected branch is added to the 15 outer else regions");

  const deepMid = await buildIfdef(oddL.slice(0, 4), "it-ifdef-deep-mid", "ifdef-deep");
  for (let i = 1; i <= 8; i++) assertSourceLine(deepMid.src, `logic t${i};`, true);
  for (let i = 9; i <= 16; i++) assertSourceLine(deepMid.src, `logic t${i};`, false);
  for (let i = 1; i <= 8; i++) assertSourceLine(deepMid.src, `logic e${i};`, false);
  assertSourceLine(deepMid.src, "logic e9;", true);
  for (let i = 10; i <= 16; i++) assertSourceLine(deepMid.src, `logic e${i};`, false);
  assert.equal(deepMid.src.inactiveRegions.length, 9,
    "an inactive level 9 subtree is one region plus eight outer else regions");

  // Conditional directives inside a macro body are expanded at the call site;
  // they must not gray the call or the macro definition source.
  const ifdefMacro = await createProject("ifdef-macro-it", "ifdef-macro", { topModule: "top" });
  const ifdefMacroJob = await build(ifdefMacro.project.projectId, "it-ifdef-macro");
  assert.equal(ifdefMacroJob.state, "COMPLETE");
  const ifdefMacroSid = (await ok("GET", `/api/projects/${ifdefMacro.project.projectId}/snapshots`))[0].snapshotId;
  const ifdefMacroRoot = (await ok("GET", `/api/projects/${ifdefMacro.project.projectId}/snapshots/${ifdefMacroSid}/hierarchy/children`)).records[0];
  const ifdefMacroSrc = await ok("GET", `/api/projects/${ifdefMacro.project.projectId}/snapshots/${ifdefMacroSid}/source?sourceId=${ifdefMacroRoot.definitionSourceId}&instanceId=${ifdefMacroRoot.id}&startLine=1`);
  assert.equal(ifdefMacroSrc.inactiveRegions.length, 0,
    "macro-expansion conditionals are not source-level inactive regions");
  assertSourceLine(ifdefMacroSrc, "assign m = `PICK_VALUE(1'b1);", true);
  const pickMacro = ifdefMacroSrc.refs.find((r) => r.kind === "macro" && (r.label || "").includes("PICK_VALUE"));
  assert.ok(pickMacro, "the macro call remains clickable");
  const macroDefSrc = await ok("GET", `/api/projects/${ifdefMacro.project.projectId}/snapshots/${ifdefMacroSid}/source?sourceId=${pickMacro.targetSourceId}&startLine=1`);
  assert.equal(macroDefSrc.inactiveRegions.length, 0,
    "macro-body conditionals are not evaluated at definition time");
  const macroIfdefLine = macroDefSrc.lines.find((l) => l.text.includes("ifdef INNER_MACRO_FLAG"));
  assert.ok(macroIfdefLine?.active, "macro body source stays active");

  // 3f. unnamed generate constructs use slang's generated names and stay unique
  const genNames = await createProject("generate-names-it", "generate-names", { topModule: "top" });
  const genNamesJob = await build(genNames.project.projectId, "it-generate-names");
  assert.equal(genNamesJob.state, "COMPLETE");
  const genNamesSid = (await ok("GET", `/api/projects/${genNames.project.projectId}/snapshots`))[0].snapshotId;
  const genNamesRoot = (await ok("GET", `/api/projects/${genNames.project.projectId}/snapshots/${genNamesSid}/hierarchy/children`)).records[0];
  const genNameKids = (await ok("GET", `/api/projects/${genNames.project.projectId}/snapshots/${genNamesSid}/hierarchy/children?parentId=${genNamesRoot.id}`)).records;
  const unnamedIf = genNameKids.find((r) => r.kind === "generate");
  assert.ok(unnamedIf);
  assert.match(unnamedIf.name, /^genblk\d+$/, "unnamed if-generate uses slang's genblk name");
  const unnamedIters = genNameKids.filter((r) => r.kind === "generate_iter");
  assert.equal(unnamedIters.length, 2);
  assert.match(unnamedIters[0].name, /^genblk\d+\[0\]$/, "unnamed for-generate entry uses a genblk name");
  const unnamedBase = unnamedIters[0].name.slice(0, unnamedIters[0].name.indexOf("["));
  assert.equal(unnamedIters[1].name, `${unnamedBase}[1]`);
  assert.equal(new Set(genNameKids.map((r) => r.name)).size, genNameKids.length, "sibling generate names are unique");

  // 3f. duplicate instance bodies still expose drivers on every instance
  const dup = await createProject("duplicate-it", "duplicate", { topModule: "top" });
  const dupJob = await build(dup.project.projectId, "it-duplicate");
  assert.equal(dupJob.state, "COMPLETE");
  const dupSid = (await ok("GET", `/api/projects/${dup.project.projectId}/snapshots`))[0].snapshotId;
  const dupRoot = (await ok("GET", `/api/projects/${dup.project.projectId}/snapshots/${dupSid}/hierarchy/children`)).records[0];
  const dupKids = (await ok("GET", `/api/projects/${dup.project.projectId}/snapshots/${dupSid}/hierarchy/children?parentId=${dupRoot.id}`)).records;
  assert.deepEqual(dupKids.map((r) => r.name), ["u1", "u2"]);
  const dupTopSrc = await ok("GET", `/api/projects/${dup.project.projectId}/snapshots/${dupSid}/source?sourceId=${dupRoot.definitionSourceId}&instanceId=${dupRoot.id}&startLine=1`);
  assert.equal(dupTopSrc.lines.find((l) => l.line === 1)?.active, false,
    "another module in the same file is inactive for the top instance");
  assert.equal(dupTopSrc.lines.find((l) => l.line === 8)?.active, true,
    "the current module definition stays active");
  assert.ok(dupTopSrc.refs.every((r) => {
    const line = dupTopSrc.lines.find((l) => l.startByte <= r.startByte && l.endByte > r.startByte);
    return !line || line.line >= 8;
  }), "the other module exposes no semantic references in top's scope");
  for (const kid of dupKids) {
    const kidScope = await ok("GET", `/api/projects/${dup.project.projectId}/snapshots/${dupSid}/source?sourceId=${kid.definitionSourceId}&instanceId=${kid.id}&startLine=1`);
    assert.equal(kidScope.lines.find((l) => l.line === 1)?.active, true,
      `${kid.name} activates the leaf module definition`);
    assert.equal(kidScope.lines.find((l) => l.line === 8)?.active, false,
      `${kid.name} grays out the other module in the same file`);
    assert.equal(kidScope.activeRegions.find((r) => r.label === "leaf")?.kind, "module");
  }
  for (const kid of dupKids) {
    const kidSrc = await ok("GET", `/api/projects/${dup.project.projectId}/snapshots/${dupSid}/source?sourceId=${kid.definitionSourceId}&instanceId=${kid.id}&startLine=1`);
    const yDecl = kidSrc.refs.find((r) => r.role === "declaration" && (r.label || "").endsWith(" y"));
    assert.ok(yDecl, `${kid.name} output y is indexed`);
    const yDrivers = await ok("GET", `/api/projects/${dup.project.projectId}/snapshots/${dupSid}/drivers?instanceId=${kid.id}&symbolId=${yDecl.targetId}`);
    assert.ok(yDrivers.records.some((r) => r.kind === "continuous"),
      `${kid.name} exposes its continuous driver despite body deduplication`);
  }

  // 4. warning, warning-as-error, broken
  const warning = await createProject("warning-it", "warning", { warningOptions: ["width-trunc"] });
  const warningJob = await build(warning.project.projectId, "it-warning");
  assert.equal(warningJob.state, "COMPLETE");
  assert.equal(warningJob.diagnostics.warning, 1);
  const werror = await createProject("warning-as-error-it", "warning", { warningOptions: ["width-trunc"], warningAsError: true });
  const werrorJob = await build(werror.project.projectId, "it-warning-as-error");
  assert.equal(werrorJob.state, "FAILED");
  assert.equal(werrorJob.snapshotId, null);
  assert.ok(werrorJob.diagnostics.error >= 1);
  const broken = await createProject("broken-it", "broken");
  const brokenJob = await build(broken.project.projectId, "it-broken");
  assert.equal(brokenJob.state, "FAILED");
  assert.equal(brokenJob.snapshotId, null);
  assert.equal(brokenJob.diagnostics.error, 1);
  const brokenDiag = await ok("GET", `/api/projects/${broken.project.projectId}/jobs/${brokenJob.jobId}/diagnostics`);
  assert.ok(brokenDiag.records.some((d) => d.severity === "error" && d.primaryLocation?.displayPath === "broken.sv"));

  // 4b. missing environment variable and unreadable source are explicit errors
  const missingEnvDir = copyFixture("missing-env-it", "simple");
  fs.writeFileSync(path.join(missingEnvDir, "design.f"), "$RTL_MISSING_ROOT/leaf.sv\ntop.sv\n");
  hashes.set(missingEnvDir, hashTree(missingEnvDir));
  const missingEnv = await createProject("missing-env-it", "simple", {}, missingEnvDir);
  const missingEnvJob = await build(missingEnv.project.projectId, "it-missing-env");
  assert.equal(missingEnvJob.state, "FAILED");
  assert.match(missingEnvJob.error?.message ?? "", /RTL_MISSING_ROOT/);

  if (process.platform !== "win32") {
    const unreadableDir = copyFixture("unreadable-it", "simple");
    fs.chmodSync(path.join(unreadableDir, "leaf.sv"), 0o000);
    const unreadable = await createProject("unreadable-it", "simple", {}, unreadableDir);
    const unreadableJob = await build(unreadable.project.projectId, "it-unreadable");
    fs.chmodSync(path.join(unreadableDir, "leaf.sv"), 0o644);
    assert.equal(unreadableJob.state, "FAILED");
    assert.match(unreadableJob.error?.message ?? "", /readable|permission|denied/i);
  }

  // 5. config change purges old build state, same config reuses
  const purge = await createProject("purge-it", "simple");
  const p1 = await build(purge.project.projectId, "it-purge-1");
  assert.equal(p1.state, "COMPLETE");
  const oldSid = p1.snapshotId;
  // Change both the configuration and the RTL, then rebuild. The new snapshot
  // must be produced from the updated source, never restored from the old one.
  const purgeTop = path.join(purge.dir, "top.sv");
  const oldPurgeTop = fs.readFileSync(purgeTop, "utf8");
  const newPurgeTop = oldPurgeTop.replace("8'h12", "8'h34");
  assert.notEqual(newPurgeTop, oldPurgeTop);
  fs.writeFileSync(purgeTop, newPurgeTop);
  hashes.set(purge.dir, hashTree(purge.dir));
  const cfg = {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "top",
    defines: [{ name: "PURGE_TEST", value: "1" }], includeRoots: [], libraries: [], parameters: [],
    language: "1800-2017", singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
  };
  const upd = await ok("PUT", `/api/projects/${purge.project.projectId}/config`, { config: cfg, expectedRevision: 1 });
  assert.equal(upd.config.configRevision, 2);
  assert.equal(upd.snapshotDiscarded, true, "config change deletes the previous snapshot immediately");
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/snapshots`)).length, 0);
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/jobs`)).length, 0);
  const p2 = await build(purge.project.projectId, "it-purge-2", 2);
  assert.equal(p2.state, "COMPLETE");
  assert.equal(p2.purged, false, "the old state was already discarded when config changed");
  assert.notEqual(p2.snapshotId, oldSid);
  const p2Root = (await ok("GET", `/api/projects/${purge.project.projectId}/snapshots/${p2.snapshotId}/hierarchy/children`)).records[0];
  const p2Source = await ok("GET", `/api/projects/${purge.project.projectId}/snapshots/${p2.snapshotId}/source?sourceId=${p2Root.definitionSourceId}&instanceId=${p2Root.id}&startLine=1`);
  assert.ok(p2Source.lines.some((l) => l.text.includes("8'h34")),
    "rebuild compiled the updated RTL source");
  assert.ok(!p2Source.lines.some((l) => l.text.includes("8'h12")),
    "rebuild did not restore the old snapshot source");
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/snapshots`)).length, 1);
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/jobs`)).length, 1);
  const same = await ok("PUT", `/api/projects/${purge.project.projectId}/config`, { config: cfg, expectedRevision: 2 });
  assert.equal(same.config.configRevision, 3);
  assert.equal(same.snapshotDiscarded, false, "saving identical config keeps the snapshot");
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/snapshots`)).length, 1);
  const p3 = await build(purge.project.projectId, "it-purge-3", 3);
  assert.equal(p3.state, "COMPLETE", JSON.stringify(p3, null, 2) + "\n" + stderr);
  assert.equal(p3.purged, false);
  assert.equal(p3.snapshotId, p2.snapshotId);
  const discard = await ok("POST", `/api/projects/${purge.project.projectId}/snapshot/discard`);
  assert.equal(discard.discarded, true);
  assert.equal(discard.config.configRevision, 3);
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/snapshots`)).length, 0);
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}/jobs`)).length, 0);
  assert.equal((await ok("GET", `/api/projects/${purge.project.projectId}`)).current, null);

  // 5b. single-file snapshot export/import
  const bundleSource = await createProject("bundle-it", "simple");
  const bundleJob = await build(bundleSource.project.projectId, "it-bundle-1");
  assert.equal(bundleJob.state, "COMPLETE");
  const bundleSid = bundleJob.snapshotId;
  const exported = await download(
    `/api/projects/${bundleSource.project.projectId}/snapshots/${bundleSid}/export?filename=${encodeURIComponent("../../shared snapshot")}`,
  );
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/vnd.rtlb.snapshot");
  const disposition = exported.headers.get("content-disposition") ?? "";
  assert.match(disposition, /\.rtlbsnap/);
  assert.ok(!disposition.includes("/"), "export filename must not contain a path");
  const { header } = bundleHeader(exported.body);
  assert.equal(header.snapshotId, bundleSid);
  assert.equal(header.extractorVersion, "0.9.11");
  const bundleFile = path.join(STATE, "moved-snapshot.rtlbsnap");
  fs.writeFileSync(bundleFile, exported.body);

  const importedDir = path.join(STATE, "projects", `imported-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(importedDir, { recursive: true });
  const imported = await importBundle(importedDir, fs.readFileSync(bundleFile));
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.ok, true);
  assert.equal(fs.existsSync(path.join(importedDir, "design.f")), false,
    "snapshot import does not require the original source tree");
  assert.equal(imported.body.data.snapshot.snapshotId, bundleSid);
  assert.notEqual(imported.body.data.project.projectId, bundleSource.project.projectId);
  const importedPid = imported.body.data.project.projectId;
  const importedSid = imported.body.data.snapshot.snapshotId;
  const importedRoots = await ok("GET", `/api/projects/${importedPid}/snapshots/${importedSid}/hierarchy/children`);
  assert.equal(importedRoots.records[0].path, "top");
  const importedWindow = await ok(
    "GET",
    `/api/projects/${importedPid}/snapshots/${importedSid}/source?sourceId=${importedRoots.records[0].definitionSourceId}&instanceId=${importedRoots.records[0].id}&startLine=1`,
  );
  assert.ok(importedWindow.lines.length > 0);
  const importedManifest = JSON.parse(fs.readFileSync(
    path.join(currentSessionDir(importedDir), "snapshots", importedSid, "manifest.json"), "utf8",
  ));
  assert.equal(importedManifest.projectId, importedPid, "imported manifest is rebound to the local project");
  assert.equal(importedManifest.snapshotId, bundleSid);
  assert.ok(!fs.existsSync(path.join(importedDir, ".rtlb", "project.json")), "no legacy root-level project file");
  const reexported = await download(`/api/projects/${importedPid}/snapshots/${importedSid}/export?filename=again`);
  assert.equal(reexported.status, 200);
  assert.equal(bundleHeader(reexported.body).header.snapshotId, bundleSid);

  const mismatchDir = path.join(STATE, "projects", `version-it-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(mismatchDir, { recursive: true });
  const badVersion = rewriteBundleHeader(exported.body, (h) => { h.extractorVersion = "0.0.1"; });
  const versionMismatch = await importBundle(mismatchDir, badVersion);
  assert.equal(versionMismatch.status, 409);
  assert.equal(versionMismatch.body.error.code, "SNAPSHOT_VERSION_MISMATCH");
  assert.equal((await ok("GET", "/api/workspace")).project, null);
  const mismatchSession = currentSessionDir(mismatchDir);
  assert.equal(fs.existsSync(path.join(mismatchSession, "project.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(mismatchSession, "snapshots")), []);

  const corruptDir = path.join(STATE, "projects", `corrupt-it-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(corruptDir, { recursive: true });
  const badMagic = Buffer.from(exported.body);
  badMagic[0] = 0x58;
  const badMagicResult = await importBundle(corruptDir, badMagic);
  assert.equal(badMagicResult.status, 400);
  assert.equal(badMagicResult.body.error.code, "INVALID_INPUT");
  const trailing = Buffer.concat([exported.body, Buffer.from([0])]);
  const trailingResult = await importBundle(corruptDir, trailing);
  assert.equal(trailingResult.status, 409);
  assert.equal(trailingResult.body.error.code, "SNAPSHOT_CORRUPT");
  const traversal = rewriteBundleHeader(exported.body, (h) => {
    h.entries.push({ path: "../escape.bin", sha256: "0".repeat(64), bytes: 1 });
  });
  const traversalResult = await importBundle(corruptDir, traversal);
  assert.equal(traversalResult.status, 400);
  assert.equal(traversalResult.body.error.code, "INVALID_INPUT");
  const duplicate = rewriteBundleHeader(exported.body, (h) => {
    h.entries.push({ ...h.entries[0] });
  });
  const duplicateResult = await importBundle(corruptDir, duplicate);
  assert.equal(duplicateResult.status, 409);
  assert.equal(duplicateResult.body.error.code, "SNAPSHOT_CORRUPT");

  // 5c. two servers on one directory use independent session state
  const sharedDir = copyFixture("shared-it", "simple");
  await ok("POST", "/api/workspace/open", { path: sharedDir });
  const sharedConfig = {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "top",
    defines: [], includeRoots: [], libraries: [], parameters: [], language: "1800-2017",
    singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
  };
  const shared1 = (await ok("POST", "/api/projects", { config: sharedConfig })).project;
  const shared1Job = await build(shared1.projectId, "it-shared-1");
  assert.equal(shared1Job.state, "COMPLETE");
  const firstSession = currentSessionDir(sharedDir);

  const server2 = spawn(process.execPath, [
    MAIN, "--workspace", STATE, "--worker", WORKER,
    "--web", path.join(ROOT, "dist", "web"), "--port", "0",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RTL_PROJECT_ROOT: ROOT },
  });
  let stderr2 = "";
  server2.stderr.on("data", (c) => { stderr2 = (stderr2 + c.toString()).slice(-10000); });
  const urlLine2 = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`second server did not start\n${stderr2}`)), 15000);
    server2.stdout.on("data", (c) => {
      buf += c.toString();
      const line = buf.split("\n").find((x) => x.startsWith("open: "));
      if (line) { clearTimeout(timer); resolve(line.slice(6).trim()); }
    });
    server2.on("exit", (code) => { if (code !== null) reject(new Error(`second server exited ${code}\n${stderr2}`)); });
  });
  try {
    const parsed2 = new URL(urlLine2);
    const base2 = `http://${HOST}:${parsed2.port}`;
    const boot2 = await fetch(urlLine2, { redirect: "manual" });
    assert.equal(boot2.status, 303);
    const cookie2 = (boot2.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie2, new RegExp(`^rtl_sid_${parsed2.port}=`));
    assert.notEqual(cookie2, cookie, "each port gets a distinct session cookie");
    const session2 = await fetch(`${base2}/api/session`, { headers: { cookie: cookie2 } }).then((r) => r.json());
    assert.equal(session2.ok, true);
    const csrf2 = session2.data.csrfToken;
    async function api2(method, p, bodyValue) {
      const headers2 = { cookie: cookie2, origin: base2 };
      if (bodyValue !== undefined) headers2["content-type"] = "application/json";
      if (method !== "GET") headers2["x-rtl-csrf"] = csrf2;
      const res = await fetch(`${base2}${p}`, {
        method, headers: headers2, body: bodyValue === undefined ? undefined : JSON.stringify(bodyValue),
      });
      const j = await res.json();
      return { status: res.status, body: j };
    }
    async function ok2(method, p, bodyValue) {
      const r = await api2(method, p, bodyValue);
      if (!r.body.ok) throw new Error(`server2 ${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.data;
    }
    const opened2 = await ok2("POST", "/api/workspace/open", { path: sharedDir });
    assert.equal(opened2.project, null, "a second server starts from a blank session, not the first server's project");
    const shared2 = (await ok2("POST", "/api/projects", { config: sharedConfig })).project;
    assert.notEqual(shared2.projectId, shared1.projectId);
    const shared2Job = await (async () => {
      const job = await ok2("POST", `/api/projects/${shared2.projectId}/build`, { configRevision: 1, requestKey: "it-shared-2" });
      for (let i = 0; i < 300; i++) {
        const j = await ok2("GET", `/api/projects/${shared2.projectId}/jobs/${job.jobId}`);
        if (["COMPLETE", "FAILED", "CANCELLED"].includes(j.state)) return j;
        await sleep(100);
      }
      throw new Error("second server build did not finish");
    })();
    assert.equal(shared2Job.state, "COMPLETE");
    const sessionNames = fs.readdirSync(path.join(sharedDir, ".rtlb", "sessions"));
    assert.equal(sessionNames.length, 2, "both live servers keep their own session directory");
    const secondSession = sessionNames
      .map((name) => path.join(sharedDir, ".rtlb", "sessions", name))
      .find((dir) => path.basename(dir) !== path.basename(firstSession));
    assert.ok(secondSession);
    assert.equal((await ok("GET", `/api/projects/${shared1.projectId}/snapshots`)).length, 1,
      "the first server still sees its own snapshot while the second builds");
    await stopServer(server2, async () => { await ok2("POST", "/api/app/exit"); });
    assert.equal(fs.existsSync(secondSession), false, "stopping one server removes only its session");
    assert.equal(fs.existsSync(firstSession), true, "the other server's session remains");
    assert.equal((await ok("GET", `/api/projects/${shared1.projectId}/snapshots`)).length, 1);
  } finally {
    await stopServer(server2);
  }

  // 6. path browser boundary and source immutability
  const denied = await api("GET", `/api/paths?path=/etc`);
  assert.ok(denied.status === 403 || denied.status === 400);
  assert.equal(hashTree(ENV_PROJECT), envHash, "env project source changed");
  assert.equal(hashTree(ENV_EXTERNAL), externalHash, "external source changed");
  for (const [dir, hash] of hashes) assert.equal(hashTree(dir), hash, `${dir} source changed`);

  console.log("integration: PASS");
} catch (error) {
  if (process.env.RTL_TEST_PRESERVE_FAILURES === "1") {
    const evidence = path.join(ROOT, ".sandbox", "evidence", path.basename(STATE));
    fs.cpSync(STATE, evidence, { recursive: true });
    console.error(`integration failure evidence: ${evidence}`);
  }
  throw error;
} finally {
  await stopServer(server, async () => { await api("POST", "/api/app/exit"); });
  for (const name of fs.readdirSync(path.join(STATE, "projects"))) {
    const sessions = path.join(STATE, "projects", name, ".rtlb", "sessions");
    assert.ok(
      !fs.existsSync(sessions) || fs.readdirSync(sessions).length === 0,
      `graceful shutdown removes session state for ${name}`,
    );
  }
  fs.rmSync(STATE, { recursive: true, force: true });
}
